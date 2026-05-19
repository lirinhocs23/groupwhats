process.env.TZ = 'America/Sao_Paulo';
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const database = require('./database');
const dayjs = require('dayjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mapa para manter as instâncias ativas do WhatsApp na memória
// Estrutura: { [usuarioId]: { client: Client, status: string, qr: string, numero: string } }
const sessoesAtivas = {};

// Controle Anti-Spam e Concorrência para evitar mensagens duplicadas
const mensagensProcessadas = new Set();
const ultimosAvisosEnviados = {}; // { [participanteId]: timestamp }
const usuariosSendoRemovidos = new Set();
let delecaoEmAndamento = false;
const filaDelecao = [];

/**
 * Inicializa a sessão do WhatsApp para um usuário específico.
 */
function inicializarSessao(usuarioId, socket = null) {
  // Se a sessão já existe na memória
  if (sessoesAtivas[usuarioId]) {
    const sessao = sessoesAtivas[usuarioId];
    console.log(`ℹ️ Sessão já ativa na memória para o usuário ${usuarioId}. Status: ${sessao.status}`);
    if (socket) {
      socket.emit('status', { status: sessao.status, qr: sessao.qr, numero: sessao.numero });
    }
    return;
  }

  console.log(`⏳ Inicializando nova sessão do WhatsApp para o usuário: ${usuarioId}`);
  
  // Limpa arquivos de trava do Chromium (SingletonLock) caso o container tenha sido reiniciado de forma abrupta.
  // Evitamos fs.existsSync pois ele retorna false para links simbólicos quebrados no Linux, impedindo a exclusão!
  try {
    const authPath = process.env.WWEBJS_AUTH_PATH || path.join(__dirname, '.wwebjs_auth');
    const sessionDir = path.join(authPath, `session-${usuarioId}`);
    const lockFile = path.join(sessionDir, 'SingletonLock');
    
    try {
      fs.unlinkSync(lockFile);
      console.log(`🧹 Lock residual "SingletonLock" (link simbólico) removido com sucesso para ${usuarioId}.`);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }
  } catch (err) {
    console.error(`⚠️ Falha ao limpar lock do Chromium para ${usuarioId}:`, err.message);
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: usuarioId,
      dataPath: process.env.WWEBJS_AUTH_PATH || undefined
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-dev-shm-usage',
        '--no-zygote',
        '--single-process'
      ]
    }
  });

  sessoesAtivas[usuarioId] = {
    client,
    status: 'inicializando',
    qr: '',
    numero: ''
  };

  if (socket) {
    socket.emit('status', { status: 'inicializando', qr: '', numero: '' });
  }

  // Evento: QR Code gerado
  client.on('qr', (qr) => {
    console.log(`📱 QR Code gerado para o usuário: ${usuarioId}`);
    if (sessoesAtivas[usuarioId]) {
      sessoesAtivas[usuarioId].status = 'qr';
      sessoesAtivas[usuarioId].qr = qr;
    }
    database.salvarSessao(usuarioId, `session_${usuarioId}`, 'qr');
    
    // Notifica o cliente específico via Socket.io
    io.to(usuarioId).emit('status', { status: 'qr', qr, numero: '' });
  });

  // Evento: Conexão bem-sucedida
  client.on('ready', async () => {
    const numero = client.info.wid.user;
    console.log(`✅ WhatsApp conectado com sucesso para o usuário ${usuarioId} (${numero})`);
    
    if (sessoesAtivas[usuarioId]) {
      sessoesAtivas[usuarioId].status = 'conectado';
      sessoesAtivas[usuarioId].qr = '';
      sessoesAtivas[usuarioId].numero = numero;
    }
    await database.salvarSessao(usuarioId, `session_${usuarioId}`, 'conectado', numero);

    // Sincroniza todos os grupos do usuário em segundo plano assim que conecta
    try {
      console.log(`📦 Sincronizando grupos iniciais para o usuário ${usuarioId}...`);
      const chats = await client.getChats();
      const grupos = chats.filter(chat => chat.isGroup);
      for (const grupo of grupos) {
        await database.registrarGrupoVazio(usuarioId, grupo.id._serialized, grupo.name);
      }
      console.log(`✅ Sincronização automática de ${grupos.length} grupos concluída.`);
    } catch (err) {
      console.error('⚠️ Erro ao sincronizar grupos iniciais:', err.message);
    }

    io.to(usuarioId).emit('status', { status: 'conectado', qr: '', numero });
  });

  // Evento: Falha na autenticação
  client.on('auth_failure', async (msg) => {
    console.error(`⚠️ Falha de autenticação para o usuário ${usuarioId}:`, msg);
    await encerrarSessao(usuarioId, true);
  });

  // Evento: Desconectado pelo celular ou navegador
  client.on('disconnected', async (reason) => {
    console.log(`⛔ WhatsApp desconectado para o usuário ${usuarioId}. Razão:`, reason);
    await encerrarSessao(usuarioId, true);
  });

  // Evento: Captura de mensagens para estatísticas (Grupos apenas)
  client.on('message', async (msg) => {
    processarMensagemEntrada(usuarioId, client, msg);
  });

  client.on('message_create', async (msg) => {
    processarMensagemEntrada(usuarioId, client, msg);
  });

  client.initialize().catch(err => {
    console.error(`❌ Erro ao inicializar cliente WhatsApp para ${usuarioId}:`, err.message);
    encerrarSessao(usuarioId, false);
  });
}

/**
 * Encerra e destrói uma instância de sessão do WhatsApp.
 * Se forcarLogoff for true, limpa o token de login local para permitir escanear outro QR Code.
 */
async function encerrarSessao(usuarioId, forcarLogoff = false) {
  console.log(`🔌 Encerrando sessão do WhatsApp para o usuário: ${usuarioId} (Logoff completo: ${forcarLogoff})`);
  
  if (sessoesAtivas[usuarioId]) {
    const { client } = sessoesAtivas[usuarioId];
    try {
      if (forcarLogoff) {
        try {
          await client.logout();
        } catch (e) {
          // Se falhar (ex: socket offline), tenta fechar de forma segura
          await client.destroy();
        }
      } else {
        await client.destroy();
      }
    } catch (e) {
      console.error(`⚠️ Erro ao destruir cliente de ${usuarioId}:`, e.message);
    }
    delete sessoesAtivas[usuarioId];
  }

  await database.salvarSessao(usuarioId, `session_${usuarioId}`, 'desconectado', '');
  io.to(usuarioId).emit('status', { status: 'desconectado', qr: '', numero: '' });
}

/**
 * Analisa uma imagem em base64 usando a API do Gemini 1.5 Flash para detectar tragédias, acidentes ou violência.
 */
async function analisarImagemComIA(base64Data, mimeType, apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const payload = {
      contents: [
        {
          parts: [
            {
              text: "Analise esta imagem enviada em um grupo de chat. Ela se enquadra em alguma destas categorias proibidas:\n" +
                    "1. Cenas de acidentes de trânsito, capotamento, carros destruídos, tragédias, violência física, sangue, mutilação ou conteúdo chocante/gore.\n" +
                    "2. Anúncios, prints, panfletos ou banners promovendo jogos de azar, cassinos online, apostas esportivas, robô do pix, plataformas de ganhos rápidos (como Fortune Tiger/Tigrinho, Blaze, Betano).\n" +
                    "3. Panfletos de venda de produtos alheios à Tradição de Espadas/fogos de artifício (como rifas de carros/celulares ou propagandas de outros negócios comuns).\n\n" +
                    "Nota: Fotos de espadas artesanais de fogo, pólvora, bambus, prensa de barro ou fogueiras são PERMITIDAS e não devem ser bloqueadas.\n" +
                    "Responda estritamente apenas com a palavra SIM se contiver conteúdo proibido, ou NAO se for permitido/seguro."
            },
            {
              inlineData: {
                mimeType: mimeType,
                data: base64Data
              }
            }
          ]
        }
      ]
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.warn(`⚠️ API Gemini respondeu com status de erro: ${res.status}`);
      return 'NAO';
    }
    
    const data = await res.json();
    const textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text?.toUpperCase() || 'NAO';
    return textoResposta.includes('SIM') ? 'SIM' : 'NAO';
  } catch (err) {
    console.error('⚠️ Erro na análise de visão do Gemini:', err.message);
    return 'NAO';
  }
}

/**
 * Fila sequencial assíncrona para exclusão de mensagens
 */
async function processarFilaDelecao() {
  if (delecaoEmAndamento) return;
  delecaoEmAndamento = true;

  while (filaDelecao.length > 0) {
    const msg = filaDelecao.shift();
    try {
      await msg.delete(true);
      console.log(`🗑️ Mensagem proibida apagada no SaaS de forma sequencial na fila.`);
    } catch (err) {
      console.error('❌ Erro ao apagar mensagem na fila do SaaS:', err.message);
    }
    // Aguarda um intervalo de estabilização de 400ms para o DOM do Puppeteer
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  delecaoEmAndamento = false;
}

/**
 * Deleta uma mensagem do WhatsApp de forma serializada (fila) para evitar
 * colisões de cliques e popups concorrentes no DOM do Puppeteer.
 */
async function deletarMensagemComFila(msg) {
  filaDelecao.push(msg);
  processarFilaDelecao();
}

/**
 * Normaliza um texto para fins de filtragem:
 * 1. Remove acentos e diacríticos.
 * 2. Substitui caracteres comuns de leetspeak (ex: @, 1, 0, !, etc.).
 * 3. Remove caracteres não alfanuméricos (mantendo letras, números e espaços simples).
 * 4. Converte para caixa baixa (lowercase).
 */
function normalizarTextoParaFiltro(texto) {
  if (!texto) return '';
  
  let textoNormalizado = texto.toLowerCase();
  
  // Normaliza acentuações Unicode
  textoNormalizado = textoNormalizado.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  
  // Substitui leetspeak comum
  const leetMap = {
    '@': 'a',
    '4': 'a',
    '1': 'i',
    '!': 'i',
    '|': 'i',
    '0': 'o',
    '3': 'e',
    '5': 's',
    '$': 's'
  };
  
  for (const [leet, normal] of Object.entries(leetMap)) {
    textoNormalizado = textoNormalizado.replaceAll(leet, normal);
  }
  
  // Remove emojis, asteriscos, hifens, pontos e caracteres especiais, mantendo apenas letras, números e espaços
  textoNormalizado = textoNormalizado.replace(/[^a-z0-9\s]/g, '');
  
  // Substitui múltiplos espaços por um espaço simples e apara as pontas
  textoNormalizado = textoNormalizado.replace(/\s+/g, ' ').trim();
  
  return textoNormalizado;
}

/**
 * Processamento interno para salvar logs de mensagens recebidas/criadas
 */
async function processarMensagemEntrada(usuarioId, client, msg) {
  try {
    // Evita processamento duplicado para a mesma mensagem (devido a múltiplos eventos message/message_create)
    if (msg.id && msg.id.id) {
      if (mensagensProcessadas.has(msg.id.id)) {
        return;
      }
      mensagensProcessadas.add(msg.id.id);
      
      // Limpa periodicamente o Set para não estourar a memória
      if (mensagensProcessadas.size > 2000) {
        mensagensProcessadas.clear();
      }
    }

    // Processa apenas mensagens vindas de grupos
    if (msg.from.endsWith('@g.us')) {
      const chat = await msg.getChat();
      if (!chat.isGroup) return;

      const groupId = chat.id._serialized;
      const nomeGrupo = chat.name;
      let participanteId = msg.author || msg.from;
      
       // Se for LID, mapeia para o número de celular real JID (@c.us) para manter compatibilidade total no banco
      if (participanteId && participanteId.endsWith('@lid')) {
        try {
          const contato = await msg.getContact();
          if (contato) {
            if (contato.id && contato.id._serialized && contato.id._serialized.endsWith('@c.us')) {
              participanteId = contato.id._serialized;
            } else if (contato.number) {
              participanteId = contato.number + '@c.us';
            }
          }
        } catch (err) {
          console.error('⚠️ Falha ao mapear LID no recebimento de mensagem:', err.message);
        }
      }
      
      // Ignora mensagens do próprio bot
      if (participanteId === client.info.wid._serialized) return;

      const corpo = msg.body || '';

      // ─── COMANDOS DO BOT MULTI-TENANT (SaaS) ───
      if (corpo.startsWith('/')) {
        let eAdmin = msg.fromMe;
        if (!eAdmin) {
          try {
            const participante = chat.participants.find(p => p.id._serialized === participanteId);
            if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
              eAdmin = true;
            }
          } catch (err) {
            console.error('⚠️ Erro ao verificar privilégios de admin:', err.message);
          }
        }

        // 1. Comando /ajuda
        if (corpo === '/ajuda') {
          const textoAjuda = `🤖 *Comandos do Bot de Gestão de Grupos SaaS:*\n\n` +
            `📊 *Gestão & Engajamento:* (Para Administradores)\n` +
            `• \`/fantasmas [limite] [pv|gp]\` - Lista membros com menos de [limite] mensagens (padrão: 3).\n` +
            `• \`/inativos [dias] [pv|gp]\` - Lista membros sem mensagens há [dias] dias (padrão: 30).\n` +
            `• \`/relatorio [dias] [limite]\` - Envia no privado um relatório em arquivo TXT completo.\n\n` +
            `🚫 *Moderação:* (Apenas para o Dono do Bot)\n` +
            `• \`/ban @membro\` - Remove o membro mencionado.\n` +
            `• \`/baninativo @membro\` - Remove o membro mencionado por inatividade.\n\n` +
            `💡 *Observação:* Se escolher o modo \`pv\`, a lista com as menções será enviada diretamente no seu privado para discrição!`;
          await chat.sendMessage(textoAjuda);
          return;
        }

        // 2. Comandos de Ban / BanInativo (Apenas dono do bot / msg.fromMe)
        if (corpo.startsWith('/ban ') || corpo.startsWith('/baninativo ')) {
          if (!msg.fromMe) {
            console.log(`⛔ Comando /ban negado para ${participanteId} no grupo "${nomeGrupo}" (não é o dono do bot)`);
            return;
          }

          const botParticipant = chat.participants.find(p => p.id._serialized === client.info.wid._serialized);
          if (!botParticipant || (!botParticipant.isAdmin && !botParticipant.isSuperAdmin)) {
            await chat.sendMessage("⚠️ *Erro:* Eu preciso ser administrador do grupo para poder banir membros!");
            return;
          }

          let targetId = '';
          if (msg.mentionedIds && msg.mentionedIds.length > 0) {
            targetId = msg.mentionedIds[0];
          } else {
            const partes = corpo.split(' ');
            const numero = partes[1] ? partes[1].replace(/\D/g, '') : '';
            if (numero) {
              targetId = `${numero}@c.us`;
            }
          }

          if (!targetId) {
            const cmdName = corpo.startsWith('/baninativo') ? '/baninativo' : '/ban';
            await chat.sendMessage(`⚠️ *Uso correto:* \`${cmdName} @membro\` ou \`${cmdName} 5511999999999\``);
            return;
          }

          try {
            const contatoAlvo = await client.getContactById(targetId);
            const realId = contatoAlvo.id._serialized;
            await chat.removeParticipants([realId]);
            const msgBan = corpo.startsWith('/baninativo')
              ? `🚫 @${contatoAlvo.id.user} foi removido do grupo por inatividade prolongada e falta de interação.`
              : `🚫 @${contatoAlvo.id.user} foi removido do grupo por violação das regras estabelecidas.`;
            await chat.sendMessage(msgBan, { mentions: [realId] });
            console.log(`🚫 Membro ${realId} removido do grupo "${nomeGrupo}" pelo bot SaaS`);
          } catch (err) {
            await chat.sendMessage(`⚠️ *Erro ao banir:* ${err.message}`);
          }
          return;
        }

        // 3. Comando /fantasmas [limite] [pv|gp] (Admins e Dono)
        if (corpo.split(' ')[0] === '/fantasmas') {
          if (!eAdmin) {
            await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo ou o dono do bot podem usar este comando!");
            return;
          }

          const partes = corpo.split(' ');
          const limite = partes[1] !== undefined && !isNaN(parseInt(partes[1])) ? parseInt(partes[1]) : 3;
          const modo = partes[2] ? partes[2].toLowerCase() : '';
          const forcarPV = modo === 'pv';
          const forcarGrupo = modo === 'gp';

          const msgFeedback = await chat.sendMessage("⏳ *Aguarde:* Analisando membros fantasmas...");

          try {
            const mensagensRecentes = await chat.fetchMessages({ limit: 300 });
            const botId = client.info.wid._serialized;
            const stats = await database.obterEstatisticasGrupo(usuarioId, groupId, 30, limite, chat.participants, botId, mensagensRecentes, client);

            const fantasmas = stats.membrosList.filter(m => m.status === '👻 Fantasma' || m.totalMensagens < limite);

            if (fantasmas.length === 0) {
              await msgFeedback.edit(`✅ Todos os membros comuns têm mais de ${limite} mensagens! Nenhum fantasma detectado.`);
              return;
            }

            const enviarParaPV = forcarPV || (fantasmas.length > 10 && !forcarGrupo);
            let listaTexto = '';
            let mentions = [];

            for (const fantasma of fantasmas) {
              listaTexto += `• @${fantasma.numero} - ${fantasma.totalMensagens} mensage(ns)\n`;
              mentions.push(fantasma.id);
            }

            if (enviarParaPV) {
              await msgFeedback.edit(`👻 *Membros Fantasmas:* Identifiquei *${fantasmas.length}* membros com baixíssima interação (menos de ${limite} mensagens).\n\nEnviei a lista com as menções no seu privado! 😉`);
              const cabecalhoPV = `📊 *Membros com Pouca Interação — Grupo "${nomeGrupo}"*\n`;
              const corpoPV = `Estes membros enviaram menos de ${limite} mensagens:\n\n${listaTexto}\nTotal: ${fantasmas.length} fantasma(s).`;
              const senderId = msg.author || msg.from;
              await client.sendMessage(senderId, cabecalhoPV + corpoPV, { mentions });
            } else {
              const cabecalhoGrupo = `👻 *Membros com Baixa Interação (Menos de ${limite} mensagens):*\n\n`;
              const rodapeGrupo = `\n📊 Total: ${fantasmas.length} fantasma(s) detectado(s).`;
              await msgFeedback.edit(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
            }
          } catch (err) {
            console.error('❌ Erro no comando /fantasmas:', err.message);
            await msgFeedback.edit(`⚠️ *Erro ao analisar fantasmas:* ${err.message}`);
          }
          return;
        }

        // 4. Comando /inativos [dias] [pv|gp] (Admins e Dono)
        if (corpo.split(' ')[0] === '/inativos') {
          if (!eAdmin) {
            await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo ou o dono do bot podem usar este comando!");
            return;
          }

          const partes = corpo.split(' ');
          const dias = parseInt(partes[1]) || 30;
          const modo = partes[2] ? partes[2].toLowerCase() : '';
          const forcarPV = modo === 'pv';
          const forcarGrupo = modo === 'gp';

          const msgFeedback = await chat.sendMessage(`⏳ *Aguarde:* Analisando membros inativos há ${dias} dias...`);

          try {
            const mensagensRecentes = await chat.fetchMessages({ limit: 300 });
            const botId = client.info.wid._serialized;
            const stats = await database.obterEstatisticasGrupo(usuarioId, groupId, dias, 3, chat.participants, botId, mensagensRecentes, client);

            const inativos = stats.membrosList.filter(m => m.status === '👻 Inativo' || m.diasSemFalar === '∞' || (typeof m.diasSemFalar === 'number' && m.diasSemFalar >= dias));

            if (inativos.length === 0) {
              await msgFeedback.edit(`✅ Nenhum membro inativo há ${dias} dias neste grupo!`);
              return;
            }

            const enviarParaPV = forcarPV || (inativos.length > 10 && !forcarGrupo);
            let listaTexto = '';
            let mentions = [];

            for (const inativo of inativos) {
              const diasExibicao = inativo.diasSemFalar === '∞' ? '∞ (sem registro)' : `${inativo.diasSemFalar} dias`;
              listaTexto += `• @${inativo.numero} - ${diasExibicao}\n`;
              mentions.push(inativo.id);
            }

            if (enviarParaPV) {
              await msgFeedback.edit(`📋 *Membros Inativos:* Identifiquei *${inativos.length}* membros inativos há ${dias} dias.\n\nEnviei a lista detalhada com as marcações diretamente no seu privado! 😉`);
              const cabecalhoPV = `📊 *Relatório de Inativos — Grupo "${nomeGrupo}"*\n`;
              const corpoPV = `Aqui está a lista dos membros inativos há ${dias} dias:\n\n${listaTexto}\nTotal: ${inativos.length} inativo(s).`;
              const senderId = msg.author || msg.from;
              await client.sendMessage(senderId, cabecalhoPV + corpoPV, { mentions });
            } else {
              const cabecalhoGrupo = `📋 *Membros inativos há ${dias} dias:*\n\n`;
              const rodapeGrupo = `\n📊 Total: ${inativos.length} membro(s) inativo(s)`;
              await msgFeedback.edit(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
            }
          } catch (err) {
            console.error('❌ Erro no comando /inativos:', err.message);
            await msgFeedback.edit(`⚠️ *Erro ao analisar inativos:* ${err.message}`);
          }
          return;
        }

        // 5. Comando /relatorio [dias] [limite] (Admins e Dono)
        if (corpo.split(' ')[0] === '/relatorio') {
          if (!eAdmin) {
            await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo ou o dono do bot podem usar este comando!");
            return;
          }

          const partes = corpo.split(' ');
          const diasInatividade = parseInt(partes[1]) || 30;
          const limiteFantasmas = parseInt(partes[2]) || 3;

          const msgFeedback = await chat.sendMessage("⏳ *Aguarde:* Estou analisando o engajamento dos membros e gerando o relatório completo...");

          try {
            const mensagensRecentes = await chat.fetchMessages({ limit: 300 });
            const botId = client.info.wid._serialized;
            const stats = await database.obterEstatisticasGrupo(usuarioId, groupId, diasInatividade, limiteFantasmas, chat.participants, botId, mensagensRecentes, client);

            let elite = stats.ranking;
            let observadores = stats.membrosList.filter(m => m.status === '🤫 Silencioso');
            let fantasmas = stats.membrosList.filter(m => m.status === '👻 Fantasma' || m.status === '👻 Inativo');

            const agora = dayjs();
            let relatorioConteudo = `============================================================\n`;
            relatorioConteudo += `📊 RELATÓRIO DE ENGAJAMENTO - GRUPO: ${nomeGrupo}\n`;
            relatorioConteudo += `📅 Gerado em: ${agora.format('DD/MM/YYYY')} às ${agora.format('HH:mm:ss')}\n`;
            relatorioConteudo += `============================================================\n\n`;

            relatorioConteudo += `🔥 MEMBROS ATIVOS (Mais Participativos):\n`;
            relatorioConteudo += `------------------------------------------------------------\n`;
            if (elite.length === 0) {
              relatorioConteudo += `(Nenhum membro ativo detectado além do limite de ${limiteFantasmas} mensagens)\n`;
            } else {
              elite.forEach((item, index) => {
                relatorioConteudo += `${index + 1}. ${item.numero} - ${item.totalMensagens} mensagens\n`;
              });
            }
            relatorioConteudo += `\n`;

            relatorioConteudo += `🤫 OBSERVADORES (Membros Silenciosos - Pouca Interação):\n`;
            relatorioConteudo += `------------------------------------------------------------\n`;
            relatorioConteudo += `* Membros com até ${limiteFantasmas} mensagens no total:\n\n`;
            if (observadores.length === 0) {
              relatorioConteudo += `(Nenhum membro silencioso detectado)\n`;
            } else {
              observadores.slice(0, 50).forEach((item, index) => {
                relatorioConteudo += `${index + 1}. ${item.numero} - ${item.totalMensagens} msg(s) | Última em: ${item.ultimaMensagem}\n`;
              });
              if (observadores.length > 50) relatorioConteudo += `... e mais ${observadores.length - 50} observador(es).\n`;
            }
            relatorioConteudo += `\n`;

            relatorioConteudo += `👻 FANTASMAS E INATIVOS (Recomendado para Remoção):\n`;
            relatorioConteudo += `------------------------------------------------------------\n`;
            relatorioConteudo += `* Membros com 0 mensagens ou inativos há ${diasInatividade}+ dias:\n\n`;
            if (fantasmas.length === 0) {
              relatorioConteudo += `(Nenhum membro fantasma ou inativo detectado)\n`;
            } else {
              fantasmas.slice(0, 100).forEach((item, index) => {
                relatorioConteudo += `${index + 1}. ${item.numero} - Status: ${item.status} | Última em: ${item.ultimaMensagem}\n`;
              });
              if (fantasmas.length > 100) relatorioConteudo += `... e mais ${fantasmas.length - 100} fantasma(s)/inativo(s).\n`;
            }
            relatorioConteudo += `\n`;

            relatorioConteudo += `============================================================\n`;
            relatorioConteudo += `📊 ESTATÍSTICAS GERAIS DO GRUPO:\n`;
            relatorioConteudo += `------------------------------------------------------------\n`;
            relatorioConteudo += `• Total de Participantes Analisados: ${stats.totais.total}\n`;
            relatorioConteudo += `• Membros Ativos: ${stats.totais.ativos}\n`;
            relatorioConteudo += `• Observadores (Silenciosos): ${observadores.length}\n`;
            relatorioConteudo += `• Inativos / Fantasmas: ${fantasmas.length}\n`;
            relatorioConteudo += `============================================================\n`;

            const nomeArquivo = `relatorio_${nomeGrupo.replace(/[^a-zA-Z0-9]/g, '_')}_${agora.format('YYYYMMDD_HHmmss')}.txt`;
            const caminhoLocal = `./relatorios/${nomeArquivo}`;

            await fs.ensureDir('./relatorios');
            await fs.writeFile(caminhoLocal, relatorioConteudo, 'utf-8');

            console.log(`💾 Relatório TXT gerado localmente em: ${caminhoLocal}`);

            const media = MessageMedia.fromFilePath(caminhoLocal);
            const senderId = msg.author || msg.from;

            await client.sendMessage(senderId, media, {
              caption: `📊 *Relatório de Engajamento — Grupo "${nomeGrupo}"*\n\nArquivo gerado de forma 100% segura.\n\n📂 *Arquivo:* \`${nomeArquivo}\``,
              sendMediaAsDocument: true
            });

            await msgFeedback.edit(`✅ *Relatório gerado com sucesso!* Enviei o arquivo no seu privado. 📂🔒`);
          } catch (err) {
            console.error('❌ Erro ao gerar/enviar relatório:', err.message);
            await msgFeedback.edit(`⚠️ *Erro crítico ao gerar o relatório:* ${err.message}`);
          }
          return;
        }
      }



      // ─── MODERADOR AUTOMÁTICO ANTI-SPAM / ANÚNCIOS ───
      // Moderação ativa APENAS para o grupo "Espada_ruadaestacao". Outros grupos têm livre trânsito e não são moderados.
      const nomeGrupoLimpo = nomeGrupo.toLowerCase().replace(/[\s_]+/g, '_');
      const isGrupoEstacao = 
        nomeGrupoLimpo.includes('espada_ruadaestacao') || 
        nomeGrupoLimpo.includes('espada_rua_da_estacao') ||
        nomeGrupoLimpo === 'fd' || 
        nomeGrupo.toLowerCase().trim() === 'fd';

      if (isGrupoEstacao && !msg.fromMe && !corpo.startsWith('/')) {
        let eAdmin = false;
        try {
          const participante = chat.participants.find(p => p.id._serialized === participanteId);
          if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
            eAdmin = true;
          }
        } catch (e) {
          console.error('⚠️ Erro ao verificar privilégios no Moderador SaaS:', e.message);
        }

        if (!eAdmin) {
          // Se for mídia, aguarda 500ms para garantir que todos os metadados (como isForwarded) foram recebidos e preenchidos no objeto pelo whatsapp-web.js
          if (msg.hasMedia) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          const corpoNormalizado = normalizarTextoParaFiltro(corpo);
          let contemSpam = false;
          let motivoSpam = 'anúncio ou conteúdo proibido';

          // Busca as configurações customizadas do grupo se existirem no banco de dados local
          const db = await database.lerDB();
          const grupoConfig = db.atividade[usuarioId] && db.atividade[usuarioId][groupId];
          const termosCustomizados = (grupoConfig && grupoConfig.termosProibidos && grupoConfig.termosProibidos.length > 0)
            ? grupoConfig.termosProibidos
            : null;

          // 1. Filtro de Termos Proibidos Absolutos (Sempre bloqueados)
          const termosAbsolutos = [
            // Apostas, Cassinos e Jogos de Azar
            'aposta', 'bets', 'betano', 'blaze', 'cassino', 'casino', 'roleta', 'slots', 
            'tigrinho', 'fortune tiger', 'fortune ox', 'fortune rabbit', 'sorte online',
            'link de aposta', 'aposta ganhadora', 'previsao de jogo', 'esporte bets',
            
            // Plataformas de Ganhos Suspeitos / Renda Extra
            'plataforma pagando', 'ganhos suspeitos', 'renda extra', 'ganhe dinheiro', 
            'ganho garantido', 'investimento garantido', 'robo do pix',
            'oportunidade unica', 'renda facil', 'dinheiro rapido',
            
            // Spam e Correntes
            'repasse para', 'compartilhe com', 'se voce nao enviar', 'mensagem de sorte', 
            'corrente',
            
            // Termos de Tragédia / Acidentes (Segurança)
            'acidente', 'acidentes', 'colisao', 'capotou', 'capotamento', 'baleado', 
            'baleados', 'assassinato', 'homicidio', 'obito', 'vitima', 'vitimas', 
            'morreu', 'faleceu', 'corpo', 'necroterio', 'tragedia', 'grave acidente'
          ];

          for (const termo of termosAbsolutos) {
            const regex = new RegExp('\\b' + termo + '\\b', 'i');
            if (regex.test(corpoNormalizado)) {
              contemSpam = true;
              motivoSpam = `uso de termo proibido absoluto ("${termo}")`;
              break;
            }
          }

          // 2. Se houver termos customizados cadastrados no painel, bloqueamos como proibição absoluta
          if (!contemSpam && termosCustomizados) {
            for (const termo of termosCustomizados) {
              const termoNormalizado = normalizarTextoParaFiltro(termo);
              if (termoNormalizado) {
                const regex = new RegExp('\\b' + termoNormalizado + '\\b', 'i');
                if (regex.test(corpoNormalizado)) {
                  contemSpam = true;
                  motivoSpam = `uso de termo proibido personalizado ("${termo}")`;
                  break;
                }
              }
            }
          }

          // 3. Filtro de Termos Comerciais e Rifas Condicionais (Bloqueia apenas se não contiver termos da tradição de espadas)
          if (!contemSpam && !termosCustomizados) {
            const termosTradicao = [
              'espada', 'espadas', 'polvora', 'barro', 'bambivis', 'prensa', 'bambu', 
              'fogueira', 'corda', 'pilao', 'cilindro'
            ];
            
            const termosCondicionais = [
              'vendo', 'vende se', 'compre', 'comprar', 'compra', 'chama no pv', 'chama pv', 'chama no zap', 
              'valor', 'interessados', 'rifa', 'rifas', 'sorteio', 'sorteios', 'cota', 'cotas', 
              'acao entre amigos', 'bilhete', 'bilhetes', 'oportunidade de emprego', 'trabalhe'
            ];

            let contemTermoComercial = false;
            let termoComercialDetetado = '';

            for (const termo of termosCondicionais) {
              const regex = new RegExp('\\b' + termo + '\\b', 'i');
              if (regex.test(corpoNormalizado)) {
                contemTermoComercial = true;
                termoComercialDetetado = termo;
                break;
              }
            }

            if (contemTermoComercial) {
              // Verifica se há pelo menos um termo da tradição na mensagem para liberar
              let termoTradicaoDetetado = '';
              const temContextoTradicao = termosTradicao.some(termoT => {
                const regex = new RegExp('\\b' + termoT + '\\b', 'i');
                const match = regex.test(corpoNormalizado);
                if (match) {
                  termoTradicaoDetetado = termoT;
                }
                return match;
              });

              if (!temContextoTradicao) {
                contemSpam = true;
                motivoSpam = `termo comercial/rifa ("${termoComercialDetetado}") fora do contexto da Tradição de Espadas`;
              } else {
                // Emitimos log de mensagem comercial LIBERADA
                const nomeParticipante = msg._data.notifyName || participanteId.split('@')[0];
                io.to(usuarioId).emit('log_seguranca', {
                  data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                  grupo: nomeGrupo,
                  membro: participanteId.split('@')[0],
                  nome: nomeParticipante,
                  acao: 'ALLOW',
                  motivo: `Termo comercial/rifa ("${termoComercialDetetado}") liberado por citar a Tradição de Espadas ("${termoTradicaoDetetado}")`
                });
              }
            }
          }

            // 2. Filtro de Links Inteligente (Anti-Link)
            if (!contemSpam) {
              const urlRegex = /(https?:\/\/[^\s]+)/gi;
              if (urlRegex.test(corpo)) {
                // Identifica se há links permitidos configurados
                const whitelistLinks = (grupoConfig && grupoConfig.linksPermitidos) || [];
                
                // Isolamos os links encontrados no texto
                const matches = corpo.match(urlRegex) || [];
                let linkNaoAutorizado = false;
                let linkDetetado = '';

                for (const urlStr of matches) {
                  try {
                    const parsedUrl = new URL(urlStr.startsWith('http') ? urlStr : `http://${urlStr}`);
                    const hostname = parsedUrl.hostname.toLowerCase().replace('www.', '');
                    
                    // Verifica se o hostname está na whitelist ou se algum domínio da whitelist é sufixo dele
                    const estaNaWhitelist = whitelistLinks.some(allowedDomain => {
                      const domainClean = allowedDomain.toLowerCase().trim().replace('www.', '');
                      return hostname === domainClean || hostname.endsWith('.' + domainClean);
                    });

                    if (!estaNaWhitelist) {
                      linkNaoAutorizado = true;
                      linkDetetado = hostname;
                      break;
                    }
                  } catch (e) {
                    // Se falhar o parseamento, assume que é suspeito
                    linkNaoAutorizado = true;
                    linkDetetado = urlStr.substring(0, 30);
                    break;
                  }
                }

                if (linkNaoAutorizado) {
                  contemSpam = true;
                  motivoSpam = `envio de link não autorizado (${linkDetetado})`;
                }
              }
            }

            // 3. Heurística Inteligente para Mídias Encaminhadas (Com redobrada resiliência)
            if (!contemSpam && msg.hasMedia) {
              let isForwarded = msg.isForwarded || msg._data?.isForwarded || msg._data?.contextInfo?.isForwarded;
              let score = msg.forwardingScore || msg._data?.forwardingScore || msg._data?.contextInfo?.forwardingScore || 0;

              if (!isForwarded) {
                for (let tentativa = 0; tentativa < 6; tentativa++) {
                  await new Promise(resolve => setTimeout(resolve, 300));
                  isForwarded = msg.isForwarded || msg._data?.isForwarded || msg._data?.contextInfo?.isForwarded;
                  score = msg.forwardingScore || msg._data?.forwardingScore || msg._data?.contextInfo?.forwardingScore || 0;
                  if (isForwarded) {
                    console.log(`⚡ [SaaS Moderador] Metadado de encaminhamento carregado com sucesso na tentativa ${tentativa + 1}.`);
                    break;
                  }
                }
              }

              if (isForwarded) {
                if (score >= 2 || !corpo.trim()) {
                  contemSpam = true;
                  motivoSpam = 'mídia compartilhada em massa / encaminhada';
                }
              }
            }

            // 4. Análise Avançada de Imagem por IA (Opcional - Ativo se houver GEMINI_API_KEY)
            if (!contemSpam && msg.hasMedia && process.env.GEMINI_API_KEY) {
              try {
                const media = await msg.downloadMedia();
                if (media && media.mimetype.startsWith('image/')) {
                  console.log(`🤖 [Moderador IA] Analisando imagem de ${participanteId} com Gemini Vision...`);
                  const resultadoIA = await analisarImagemComIA(media.data, media.mimetype, process.env.GEMINI_API_KEY);
                  if (resultadoIA === 'SIM') {
                    contemSpam = true;
                    motivoSpam = 'conteúdo visual impróprio detectado por Inteligência Artificial (cena de acidente/tragédia)';
                  }
                }
              } catch (err) {
                console.error('⚠️ Falha ao baixar ou analisar mídia com IA:', err.message);
              }
            }

            if (contemSpam) {
              console.log(`🚨 [SaaS] SPAM/CONTEÚDO PROIBIDO DETECTADO de ${participanteId} no grupo "${nomeGrupo}": "${motivoSpam}"`);

              // 1. Apaga a mensagem na hora! (Fila serializada para evitar concorrência de cliques no Puppeteer)
              try {
                await deletarMensagemComFila(msg);
              } catch (err) {
                console.error('❌ Falha ao enfileirar deleção de mensagem:', err.message);
              }

              // Evita concorrência e spam do próprio bot
              if (usuariosSendoRemovidos.has(participanteId)) {
                return;
              }

              // Debounce de Avisos e Advertências (Máximo 1 aviso/advertência a cada 3 segundos por usuário)
              const agoraTime = Date.now();
              const ultimoAviso = ultimosAvisosEnviados[participanteId] || 0;
              if (agoraTime - ultimoAviso < 3000) {
                console.log(`⏳ [SaaS Moderador] Evitando aviso/advertência duplicada em lote para ${participanteId}.`);
                return;
              }
              ultimosAvisosEnviados[participanteId] = agoraTime;

              // 2. Registra advertência de forma persistente
              const advCount = await database.registrarAdvertencia(usuarioId, groupId, participanteId);
              const contato = await msg.getContact();
              const nomeMembro = contato ? (contato.name || contato.pushname || participanteId.split('@')[0]) : 'Membro';

              // Notifica o painel em tempo real sobre o log de moderação via Websocket
              io.to(usuarioId).emit('log_seguranca', {
                timestamp: dayjs().format('HH:mm:ss'),
                grupo: nomeGrupo,
                membro: participanteId.replace('@c.us', ''),
                nome: nomeMembro,
                motivo: motivoSpam,
                acao: advCount >= 3 ? 'BAN' : 'DELETE'
              });

              // 3. Executa a punição correspondente
              if (advCount >= 3) {
                usuariosSendoRemovidos.add(participanteId);
                setTimeout(() => usuariosSendoRemovidos.delete(participanteId), 7000);

                setTimeout(async () => {
                  try {
                    await chat.removeParticipants([participanteId]);
                    console.log(`🚫 [SaaS] Spammer ${participanteId} removido por excesso de infrações.`);
                    await chat.sendMessage(`🚫 @${contato.id.user} foi removido do grupo por atingir o limite de 3 advertências de conteúdo proibido (Conforme Regras do Grupo).`, { mentions: [contato] });
                    
                    // Reseta as advertências dele
                    await database.zerarAdvertencias(usuarioId, groupId, participanteId);
                  } catch (err) {
                    console.error('❌ Erro ao remover usuário no SaaS:', err.message);
                    await chat.sendMessage(`⚠️ @${contato.id.user} deveria ser banido por atingir 3 advertências, mas o bot não possui privilégios de Admin no grupo para removê-lo!`, { mentions: [contato] });
                  }
                }, 2200);
              } else {
                setTimeout(async () => {
                  try {
                    await chat.sendMessage(`⚠️ @${contato.id.user}, conteúdos proibidos (Conforme Regras do Grupo) não são permitidos! Advertência (${advCount}/3). A sua mensagem foi apagada.`, { mentions: [contato] });
                  } catch (err) {
                    console.error('❌ Erro ao enviar mensagem de advertência:', err.message);
                  }
                }, 2000);
              }

              return; // Interrompe para não salvar nas estatísticas gerais
            }
      }
    }

      // Obtém o nome de exibição do remetente
      const nomeParticipante = msg._data.notifyName || participanteId.split('@')[0];

      await database.registrarMensagem(usuarioId, groupId, nomeGrupo, participanteId, nomeParticipante);
      
      // Notifica o painel web para atualizar os gráficos em tempo real se o cliente estiver conectado
      io.to(usuarioId).emit('nova_mensagem', { groupId });
    }
  } catch (err) {
    console.error('⚠️ Erro ao registrar atividade no painel:', err.message);
  }
}

// ─── RESTAURAR SESSÕES ATIVAS NO STARTUP ───

async function restaurarSessoesAnteriores() {
  try {
    const db = await database.inicializarDB();
    const dbCompleto = await database.buscarUsuario('admin', 'admin'); // Apenas garante inicialização
    
    const dados = await database.obterGrupos('usr_1'); // Força leitura
    const dbJson = await database.buscarSessao('usr_1'); // Verifica sessões antigas
    
    // Lê todas as sessões salvas no JSON de forma dinâmica
    const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'db_saas.json');
    const conteudoDB = await fs.readJson(dbPath);
    const sessoesConectadas = conteudoDB.sessoes.filter(s => s.status === 'conectado' || s.status === 'qr');

    if (sessoesConectadas.length > 0) {
      console.log(`♻️ Restaurando ${sessoesConectadas.length} sessão(ões) ativa(s) anterior(es)...`);
      for (const sessao of sessoesConectadas) {
        inicializarSessao(sessao.usuarioId);
      }
    }
  } catch (err) {
    console.error('⚠️ Erro ao restaurar sessões antigas no startup:', err.message);
  }
}

// ─── ROTAS DA API HTTP ───

// Rota de Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios!' });
  }

  try {
    const usuario = await database.buscarUsuario(username, password);
    if (!usuario) {
      return res.status(401).json({ error: 'Credenciais inválidas!' });
    }

    res.json({
      id: usuario.id,
      username: usuario.username,
      nome: usuario.nome
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rota de Cadastro de Novos Usuários (SaaS)
app.post('/api/register', async (req, res) => {
  const { username, password, nome } = req.body;
  if (!username || !password || !nome) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios!' });
  }

  try {
    const novoUsuario = await database.cadastrarUsuario(username, password, nome);
    res.json({
      id: novoUsuario.id,
      username: novoUsuario.username,
      nome: novoUsuario.nome
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Listar grupos monitorados (com sincronização em tempo real se estiver conectado)
app.get('/api/groups', async (req, res) => {
  const usuarioId = req.query.usuarioId;
  if (!usuarioId) return res.status(400).json({ error: 'ID do usuário é obrigatório!' });

  try {
    // Sincroniza em tempo real com o WhatsApp se o bot estiver online
    const sessao = sessoesAtivas[usuarioId];
    if (sessao && sessao.status === 'conectado') {
      try {
        const chats = await sessao.client.getChats();
        const grupos = chats.filter(chat => chat.isGroup);
        for (const grupo of grupos) {
          await database.registrarGrupoVazio(usuarioId, grupo.id._serialized, grupo.name);
        }
      } catch (e) {
        console.error('⚠️ Falha ao sincronizar grupos na rota de API:', e.message);
      }
    }

    const grupos = await database.obterGrupos(usuarioId);
    res.json(grupos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obter estatísticas analíticas de um grupo (híbrido offline/online)
app.get('/api/stats/:groupId', async (req, res) => {
  const { groupId } = req.params;
  const usuarioId = req.query.usuarioId;
  const dias = parseInt(req.query.dias) || 30;
  const limite = parseInt(req.query.limite) || 3;

  if (!usuarioId) return res.status(400).json({ error: 'ID do usuário é obrigatório!' });

  try {
    let participantes = null;
    let mensagensRecentes = [];
    
    // Se o bot estiver online, busca a lista real e atualizada de participantes
    const sessao = sessoesAtivas[usuarioId];
    if (sessao && sessao.status === 'conectado') {
      try {
        const chat = await sessao.client.getChatById(groupId);
        if (chat.isGroup) {
          participantes = chat.participants;
          // Busca as últimas 300 mensagens em tempo real para backfill instantâneo do histórico!
          mensagensRecentes = await chat.fetchMessages({ limit: 300 });
        }
      } catch (e) {
        console.error('⚠️ Falha ao buscar participantes/mensagens do WhatsApp:', e.message);
      }
    }

    const botId = (sessao && sessao.status === 'conectado' && sessao.client.info) ? sessao.client.info.wid._serialized : null;
    const clientInstance = (sessao && sessao.status === 'conectado') ? sessao.client : null;
    const estatisticas = await database.obterEstatisticasGrupo(usuarioId, groupId, dias, limite, participantes, botId, mensagensRecentes, clientInstance);
    res.json(estatisticas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Desconectar WhatsApp manualmente pelo painel
app.post('/api/disconnect', async (req, res) => {
  const { usuarioId } = req.body;
  if (!usuarioId) return res.status(400).json({ error: 'ID do usuário é obrigatório!' });

  try {
    await encerrarSessao(usuarioId, true);
    res.json({ success: true, message: 'WhatsApp desconectado com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rota de banimento manual pelo painel
app.post('/api/ban', async (req, res) => {
  const { usuarioId, groupId, numero } = req.body;
  if (!usuarioId || !groupId || !numero) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios!' });
  }

  try {
    const sessao = sessoesAtivas[usuarioId];
    if (!sessao || sessao.status !== 'conectado') {
      return res.status(400).json({ error: 'O bot de WhatsApp não está conectado!' });
    }

    const chat = await sessao.client.getChatById(groupId);
    if (!chat.isGroup) {
      return res.status(400).json({ error: 'O chat informado não é um grupo!' });
    }

    // Formata o ID do participante
    const participanteId = numero.includes('@') ? numero : `${numero}@c.us`;

    // Efetua a remoção
    await chat.removeParticipants([participanteId]);
    console.log(`🚫 [SaaS] Membro ${participanteId} banido manualmente pelo painel web.`);
    
    // Reseta as advertências dele se houver
    await database.zerarAdvertencias(usuarioId, groupId, participanteId);

    res.json({ success: true, message: 'Membro removido com sucesso do grupo!' });
  } catch (err) {
    console.error('❌ Erro ao banir membro manualmente:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rota para zerar/perdoar advertências
app.post('/api/warnings/reset', async (req, res) => {
  const { usuarioId, groupId, numero } = req.body;
  if (!usuarioId || !groupId || !numero) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios!' });
  }

  try {
    const participanteId = numero.includes('@') ? numero : `${numero}@c.us`;
    await database.zerarAdvertencias(usuarioId, groupId, participanteId);
    res.json({ success: true, message: 'Advertências zeradas com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rota para salvar termos proibidos do grupo
app.post('/api/groups/:groupId/keywords', async (req, res) => {
  const { groupId } = req.params;
  const { usuarioId, termos } = req.body;
  if (!usuarioId || !termos) {
    return res.status(400).json({ error: 'ID do usuário e termos são obrigatórios!' });
  }

  try {
    await database.salvarTermosProibidos(usuarioId, groupId, termos);
    res.json({ success: true, message: 'Termos proibidos atualizados com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rota para salvar links permitidos (whitelist) do grupo
app.post('/api/groups/:groupId/links', async (req, res) => {
  const { groupId } = req.params;
  const { usuarioId, links } = req.body;
  if (!usuarioId || !links) {
    return res.status(400).json({ error: 'ID do usuário e links são obrigatórios!' });
  }

  try {
    await database.salvarLinksPermitidos(usuarioId, groupId, links);
    res.json({ success: true, message: 'Whitelist de links atualizada com sucesso!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rota para testar a imagem na IA (Gemini Vision Tester)
app.post('/api/ia/test', async (req, res) => {
  const { base64Data, mimeType } = req.body;
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(400).json({ error: 'Chave API do Gemini não configurada no servidor!' });
  }
  if (!base64Data || !mimeType) {
    return res.status(400).json({ error: 'Dados da imagem e tipo mime são obrigatórios!' });
  }

  try {
    const resultado = await analisarImagemComIA(base64Data, mimeType, apiKey);
    res.json({ success: true, resultado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Alterar senha do usuário
app.post('/api/change-password', async (req, res) => {
  const { usuarioId, currentPassword, newPassword } = req.body;
  if (!usuarioId || !currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios!' });
  }

  try {
    await database.alterarSenha(usuarioId, currentPassword, newPassword);
    res.json({ success: true, message: 'Senha alterada com sucesso!' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── COMUNICAÇÃO WEBSOCKET (SOCKET.IO) ───

io.on('connection', (socket) => {
  console.log(`🔌 Novo navegador conectado ao WebSocket: ${socket.id}`);

  // Cliente se junta a uma sala exclusiva baseada no seu ID de usuário
  socket.on('join_room', ({ usuarioId }) => {
    socket.join(usuarioId);
    console.log(`👥 Usuário ${usuarioId} entrou na sala WebSocket correspondente.`);
    
    // Se já houver sessão ativa na memória, envia o status atual na hora
    if (sessoesAtivas[usuarioId]) {
      const sessao = sessoesAtivas[usuarioId];
      socket.emit('status', { status: sessao.status, qr: sessao.qr, numero: sessao.numero });
    } else {
      socket.emit('status', { status: 'desconectado', qr: '', numero: '' });
    }
  });

  // Comando disparado pelo botão do painel web para conectar
  socket.on('conectar_whatsapp', ({ usuarioId }) => {
    inicializarSessao(usuarioId, socket);
  });

  // Comando disparado para desconectar pelo painel
  socket.on('desconectar_whatsapp', async ({ usuarioId }) => {
    await encerrarSessao(usuarioId, true);
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Navegador desconectado do WebSocket: ${socket.id}`);
  });
});

// Inicialização do servidor
server.listen(PORT, async () => {
  console.log(`====================================================`);
  console.log(`🚀 PAINEL WEB SAAS INICIADO COM SUCESSO!`);
  console.log(`🌐 Endereço Local: http://localhost:${PORT}`);
  console.log(`====================================================`);
  
  await restaurarSessoesAnteriores();
});
