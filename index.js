const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const dayjs = require('dayjs');

// Caminho do arquivo de atividade
const ATIVIDADE_PATH = './atividade.json';

// Carrega ou inicializa o banco de dados de atividade
async function carregarAtividade() {
  try {
    const existe = await fs.pathExists(ATIVIDADE_PATH);
    if (existe) {
      const conteudo = await fs.readJson(ATIVIDADE_PATH);
      return conteudo;
    }
  } catch (err) {
    console.log('⚠️ Erro ao carregar atividade.json, criando novo...');
  }
  return {};
}

// Salva o banco de dados de atividade
async function salvarAtividade(dados) {
  await fs.writeJson(ATIVIDADE_PATH, dados, { spaces: 2 });
}

// Inicializa o cliente WhatsApp com autenticação local (persiste sessão)
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ]
  }
});

// Banco de dados em memória
let atividade = {};

// Evento: QR Code gerado para autenticação
client.on('qr', (qr) => {
  console.log('');
  console.log('📱 Escaneie o QR Code abaixo com seu WhatsApp:');
  console.log('');
  qrcode.generate(qr, { small: true });
  console.log('');
});

// Evento: Cliente pronto
client.on('ready', async () => {
  console.log('');
  console.log('✅ Bot conectado com sucesso!');
  console.log('📊 Monitorando grupos para detectar atividade...');
  console.log('💡 Use /inativos <dias> em qualquer grupo para ver membros inativos.');
  console.log('');

  // Carrega dados salvos
  atividade = await carregarAtividade();
  console.log(`📂 Dados carregados: ${Object.keys(atividade).length} grupo(s) monitorado(s).`);
  console.log('');
  console.log('🔍 Aguardando mensagens... (se ninguém falar, nada aparece aqui)');
  console.log('');

  // Keep-alive: busca chats a cada 5 minutos para manter o Chromium ativo
  setInterval(async () => {
    try {
      await client.getChats();
      console.log(`♻️ [${dayjs().format('HH:mm:ss')}] Keep-alive OK`);
    } catch (err) {
      console.error('⚠️ Erro no keep-alive:', err.message);
    }
  }, 5 * 60 * 1000);
});

// Evento: Autenticação bem-sucedida
client.on('authenticated', () => {
  console.log('🔐 Autenticação realizada com sucesso!');
});

// Evento: Falha na autenticação
client.on('auth_failure', (msg) => {
  console.error('❌ Falha na autenticação:', msg);
});

// Evento: Desconectado
client.on('disconnected', (reason) => {
  console.log('🔌 Bot desconectado:', reason);
});

// ─── Função para processar mensagens ───
async function processarMensagem(msg, eventoOrigem) {
  try {
    // Ignora mensagens sem conteúdo (status, mídia sem legenda, etc)
    const corpo = msg.body || '';

    const chat = await msg.getChat();

    // Log bruto para debug
    console.log(`🔔 [${eventoOrigem}] from: ${msg.from} | to: ${msg.to} | author: ${msg.author || 'N/A'} | grupo: ${chat.isGroup}`);

    // Verifica se a mensagem é de um grupo
    if (!chat.isGroup) return;

    const nomeGrupo = chat.name;
    const userId = msg.author || msg.from;

    console.log(`💬 Mensagem no grupo "${nomeGrupo}" de ${userId}: "${corpo.substring(0, 50)}"`);

    // ─── MODERADOR AUTOMÁTICO ANTI-SPAM / ANÚNCIOS ───
    // Moderação ativa APENAS para o grupo "Espada_ruadaestacao". Outros grupos têm livre trânsito e não são moderados.
    const nomeGrupoLimpo = nomeGrupo.toLowerCase().replace(/[\s_]+/g, '_');
    const isGrupoEstacao = nomeGrupoLimpo.includes('espada_ruadaestacao') || nomeGrupoLimpo.includes('espada_rua_da_estacao');

    if (isGrupoEstacao && !msg.fromMe && !corpo.startsWith('/')) {
      let eAdmin = false;
      try {
        const participante = chat.participants.find(p => p.id._serialized === userId);
        if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
          eAdmin = true;
        }
      } catch (err) {
        console.error('⚠️ Erro ao verificar privilégios no Moderador:', err.message);
      }

      if (!eAdmin) {
        const corpoMinusculo = corpo.toLowerCase();

        // Exceção Cultural: Como estamos no grupo da estação, liberamos termos e negociações da tradição de espadas
        const isTradicaoEspada =
          corpoMinusculo.includes('espada') ||
          corpoMinusculo.includes('espadas') ||
          corpoMinusculo.includes('polvora') ||
          corpoMinusculo.includes('pólvora') ||
          corpoMinusculo.includes('barro') ||
          corpoMinusculo.includes('bambivis') ||
          corpoMinusculo.includes('prensa') ||
          corpoMinusculo.includes('bambu') ||
          corpoMinusculo.includes('fogueira') ||
          corpoMinusculo.includes('corda') ||
          corpoMinusculo.includes('cordas') ||
          corpoMinusculo.includes('pilao') ||
          corpoMinusculo.includes('pilão') ||
          corpoMinusculo.includes('cilindro');

        if (!isTradicaoEspada) {
          const termosProibidos = [
            'vendo', 'vende-se', 'compre', 'oportunidade única', 'oportunidade unica', 'som automotivo',
            'chama no pv', 'chama no pv interessados', 'interessados chamar no pv', 'chama no inbox', 
            'chama pv', 'chama no zap', 'valor no pv', 'chamar no pv', 'promoção de hoje', 
            'venda de carro', 'venda de moto', 'geladeira usada', 'plataforma pagando', 
            'tigrinho pagando', 'link de aposta', 'olx.com', 'mercadolivre.com', 'zé da barata', 
            'ze da barata', 'ligue e contrate', 'contratar', 'contrate', 'ligue', 'propaganda', 
            'propagandas', 'anunciar', 'anuncio', 'anúncio', 'vender', 'vende-se-loja', 
            'vende-se lojinha', 'vende-se loja virtual', 'comprar', 'promoção', 'sorte online', 
            'trabalhe em casa', 'renda extra', 'dinheiro rápido', 'ganhe dinheiro', 'emprego', 
            'vaga', 'oportunidade de emprego', 'trabalhe', 'aposta ganhadora', 'investimento garantido', 
            'previsão de jogo', 'esporte bets', 'imax control', 'control',
            // Termos de Rifeiro / Rifa
            'rifa', 'rifas', 'rifeiro', 'rifeiros', 'bilhete', 'bilhetes', 'sorteio', 
            'sorteios', 'cota', 'cotas', 'ação entre amigos', 'acao entre amigos', 
            'rifa online', 'adquira seu bilhete', 'adquira sua cota', 'compra de cota', 
            'comprar cota', 'tabela de rifa', 'tabela de rifas', 'adquira já', 'adquira ja'
          ];

          let contemSpam = false;
          for (const termo of termosProibidos) {
            if (corpoMinusculo.includes(termo)) {
              contemSpam = true;
              break;
            }
          }

          if (contemSpam) {
            console.log(`🚨 SPAM DETECTADO de ${userId} no grupo "${nomeGrupo}": "${corpo.substring(0, 100)}"`);

            // 1. Apaga a mensagem na hora!
            try {
              await msg.delete(true);
              console.log(`🗑️ Mensagem de spam apagada com sucesso.`);
            } catch (err) {
              console.error('❌ Erro ao apagar mensagem de spam:', err.message);
            }

            const groupId = chat.id._serialized;

            // 2. Registra advertência de forma persistente
            if (!atividade[groupId]) {
              atividade[groupId] = {
                nomeGrupo: nomeGrupo,
                membros: {}
              };
            }

            if (!atividade[groupId].advertencias) {
              atividade[groupId].advertencias = {};
            }

            if (!atividade[groupId].advertencias[userId]) {
              atividade[groupId].advertencias[userId] = 0;
            }

            atividade[groupId].advertencias[userId] += 1;
            const advCount = atividade[groupId].advertencias[userId];
            await salvarAtividade(atividade);

            const contato = await msg.getContact();

            // 3. Executa a punição correspondente
            if (advCount >= 3) {
              try {
                await chat.removeParticipants([userId]);
                console.log(`🚫 Usuário ${userId} removido por excesso de spam.`);
                await chat.sendMessage(`🚫 @${contato.id.user} foi removido do grupo por atingir o limite de 3 advertências de anúncios proibidos.`, { mentions: [contato] });

                // Reseta contagem do usuário banido
                delete atividade[groupId].advertencias[userId];
                await salvarAtividade(atividade);
              } catch (err) {
                console.error('❌ Erro ao remover usuário do grupo:', err.message);
                await chat.sendMessage(`⚠️ @${contato.id.user} deveria ser banido por atingir 3 advertências, mas o bot não possui privilégios de Admin para removê-lo!`, { mentions: [contato] });
              }
            } else {
              await chat.sendMessage(`⚠️ @${contato.id.user}, anúncios não são permitidos! Advertência (${advCount}/3). A sua mensagem foi apagada.`, { mentions: [contato] });
            }

            return; // Para o fluxo de processamento para não computar essa mensagem como ativa
          }
        }
      }
    }

    // ─── Comando /baninativo (Apenas Bot Master) ───
    if (corpo.split(' ')[0] === '/baninativo') {
      // Apenas o dono do bot (quem escaneou o QR Code) pode banir por inatividade
      if (!msg.fromMe) {
        console.log(`⛔ Comando /baninativo negado para ${userId} no grupo "${nomeGrupo}" (não é o bot master)`);
        return;
      }

      // Verifica se o bot é administrador no grupo
      const botParticipant = chat.participants.find(p => p.id._serialized === client.info.wid._serialized);
      if (!botParticipant || (!botParticipant.isAdmin && !botParticipant.isSuperAdmin)) {
        await chat.sendMessage("⚠️ *Erro:* Eu preciso ser administrador do grupo para poder banir membros!");
        return;
      }

      let targetId = '';

      // Verifica menções no WhatsApp
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
        await chat.sendMessage("⚠️ *Uso correto:* `/baninativo @membro` ou `/baninativo 5511999999999`");
        return;
      }

      try {
        const contatoAlvo = await client.getContactById(targetId);
        const realId = contatoAlvo.id._serialized;
        await chat.removeParticipants([realId]);
        await chat.sendMessage(`🚫 @${contatoAlvo.id.user} foi removido do grupo por inatividade prolongada e falta de interação.`, { mentions: [realId] });
        console.log(`🚫 Membro ${realId} (original: ${targetId}) removido por inatividade do grupo "${nomeGrupo}" pelo bot master`);
      } catch (err) {
        await chat.sendMessage(`⚠️ *Erro ao banir:* ${err.message}`);
      }
      return;
    }

    // ─── Comando /ban (Apenas Bot Master) ───
    if (corpo.split(' ')[0] === '/ban') {
      // Apenas o dono do bot (quem escaneou o QR Code) pode banir
      if (!msg.fromMe) {
        console.log(`⛔ Comando /ban negado para ${userId} no grupo "${nomeGrupo}" (não é o bot master)`);
        return;
      }

      console.log('🔍 [DIAGNÓSTICO BAN] Participantes no grupo:', chat.participants.map(p => ({ id: p.id._serialized, isAdmin: p.isAdmin || p.isSuperAdmin })));
      console.log('🔍 [DIAGNÓSTICO BAN] ID do Bot:', client.info.wid._serialized);

      // Verifica se o bot é administrador no grupo
      const botParticipant = chat.participants.find(p => p.id._serialized === client.info.wid._serialized);
      if (!botParticipant || (!botParticipant.isAdmin && !botParticipant.isSuperAdmin)) {
        await chat.sendMessage("⚠️ *Erro:* Eu preciso ser administrador do grupo para poder banir membros!");
        return;
      }

      let targetId = '';

      // Verifica menções no WhatsApp
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
        await chat.sendMessage("⚠️ *Uso correto:* `/ban @membro` ou `/ban 5511999999999`");
        return;
      }

      try {
        const contatoAlvo = await client.getContactById(targetId);
        const realId = contatoAlvo.id._serialized;
        await chat.removeParticipants([realId]);
        await chat.sendMessage(`🚫 @${contatoAlvo.id.user} foi removido do grupo por violação das regras estabelecidas.`, { mentions: [realId] });
        console.log(`🚫 Membro ${realId} (original: ${targetId}) removido do grupo "${nomeGrupo}" pelo bot master`);
      } catch (err) {
        await chat.sendMessage(`⚠️ *Erro ao banir:* ${err.message}`);
      }
      return;
    }

    // ─── Comando /fantasmas ───
    if (corpo.split(' ')[0] === '/fantasmas') {
      // Verifica se quem enviou é administrador do grupo ou o dono do bot
      let eAdmin = msg.fromMe;

      if (!eAdmin) {
        try {
          const contatoRemetente = await msg.getContact();
          const remetenteId = contatoRemetente.id._serialized;
          const participante = chat.participants.find(p =>
            p.id._serialized === remetenteId ||
            p.id._serialized === userId
          );
          if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
            eAdmin = true;
          }
        } catch (err) {
          console.error('⚠️ Erro ao verificar privilégios de admin:', err.message);
        }
      }

      if (!eAdmin) {
        console.log(`⛔ Comando /fantasmas negado para ${userId} no grupo "${nomeGrupo}" (não é admin)`);
        await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo podem usar este comando!");
        return;
      }

      const partes = corpo.split(' ');
      const limite = partes[1] !== undefined && !isNaN(parseInt(partes[1])) ? parseInt(partes[1]) : 3;
      const modo = partes[2] ? partes[2].toLowerCase() : '';

      const forcarPV = modo === 'pv';
      const forcarGrupo = modo === 'gp';

      console.log(`👻 Comando /fantasmas (limite: ${limite}, modo: ${modo || 'auto'}) recebido no grupo "${nomeGrupo}"`);

      const participantes = chat.participants;
      const groupId = chat.id._serialized;
      const dadosGrupo = (atividade[groupId] && atividade[groupId].membros) || {};
      let fantasmas = [];

      for (const participante of participantes) {
        const participanteId = participante.id._serialized;

        // Ignora o próprio bot e todos os administradores do grupo (para não listá-los como fantasmas)
        if (participanteId === client.info.wid._serialized) continue;
        if (participante.isAdmin || participante.isSuperAdmin) continue;

        const dadosUsuario = dadosGrupo[participanteId];

        if (!dadosUsuario) {
          fantasmas.push({
            id: participanteId,
            mensagens: 0
          });
        } else {
          const totalMsg = dadosUsuario.totalMensagens || 0;
          if (totalMsg < limite) {
            fantasmas.push({
              id: participanteId,
              mensagens: totalMsg
            });
          }
        }
      }

      if (fantasmas.length === 0) {
        await chat.sendMessage(`✅ Todos os membros comuns têm mais de ${limite} mensagens! Nenhum fantasma detectado.`);
        return;
      }

      // Define se vai enviar para o privado
      const enviarParaPV = forcarPV || (fantasmas.length > 10 && !forcarGrupo);

      // Carrega os contatos e prepara as menções
      let listaTexto = '';
      let mentions = [];

      for (const fantasma of fantasmas) {
        try {
          const contato = await client.getContactById(fantasma.id);
          mentions.push(contato.id._serialized);
          listaTexto += `• @${contato.id.user} - ${fantasma.mensagens} mensage(ns)\n`;
        } catch {
          const numLimpo = fantasma.id.replace('@c.us', '').replace('@lid', '');
          listaTexto += `• @${numLimpo} - ${fantasma.mensagens} mensage(ns)\n`;
        }
      }

      if (enviarParaPV) {
        // Envia resumo no grupo
        await chat.sendMessage(`👻 *Membros Fantasmas:* Identifiquei *${fantasmas.length}* membros com baixíssima interação (menos de ${limite} mensagens).\n\nEnviei a lista com as menções no seu privado para manter a discrição! 😉`);

        // Envia a lista completa no privado do admin
        const cabecalhoPV = `📊 *Membros com Pouca Interação — Grupo "${nomeGrupo}"*\n`;
        const corpoPV = `Estes membros enviaram menos de ${limite} mensagens desde o início do rastreamento:\n\n${listaTexto}\nTotal: ${fantasmas.length} fantasma(s).`;

        await client.sendMessage(userId, cabecalhoPV + corpoPV, { mentions });
        console.log(`📩 Relatório de fantasmas enviado para o privado de ${userId}`);
      } else {
        // Envia diretamente no grupo
        const cabecalhoGrupo = `👻 *Membros com Baixa Interação (Menos de ${limite} mensagens):*\n\n`;
        const rodapeGrupo = `\n📊 Total: ${fantasmas.length} fantasma(s) detectado(s).`;

        await chat.sendMessage(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
        console.log(`💬 Relatório de fantasmas enviado no grupo "${nomeGrupo}"`);
      }

      return;
    }

    // ─── Comando /inativos ───
    if (corpo.startsWith('/inativos')) {
      // Verifica se quem enviou é administrador do grupo ou o dono do bot
      let eAdmin = msg.fromMe;

      if (!eAdmin) {
        try {
          const contatoRemetente = await msg.getContact();
          const remetenteId = contatoRemetente.id._serialized;
          const participante = chat.participants.find(p =>
            p.id._serialized === remetenteId ||
            p.id._serialized === userId
          );
          if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
            eAdmin = true;
          }
        } catch (err) {
          console.error('⚠️ Erro ao verificar privilégios de admin:', err.message);
        }
      }

      if (!eAdmin) {
        console.log(`⛔ Comando /inativos negado para ${userId} no grupo "${nomeGrupo}" (não é admin)`);
        await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo podem usar este comando!");
        return;
      }

      const partes = corpo.split(' ');
      const dias = parseInt(partes[1]) || 30;
      const modo = partes[2] ? partes[2].toLowerCase() : '';

      const forcarPV = modo === 'pv';
      const forcarGrupo = modo === 'gp';

      console.log(`📋 Comando /inativos ${dias} (modo: ${modo || 'auto'}) recebido no grupo "${nomeGrupo}" (por admin)`);

      const participantes = chat.participants;
      const agora = dayjs();
      const groupId = chat.id._serialized;
      let dadosGrupo = (atividade[groupId] && atividade[groupId].membros) || {};

      // Migração automática de dados antigos (baseados em nome de grupo) para a nova estrutura (ID único)
      if (Object.keys(dadosGrupo).length === 0 && atividade[nomeGrupo]) {
        if (!atividade[nomeGrupo].membros) {
          atividade[groupId] = {
            nomeGrupo: nomeGrupo,
            membros: atividade[nomeGrupo]
          };
          delete atividade[nomeGrupo];
          dadosGrupo = atividade[groupId].membros;
          await salvarAtividade(atividade);
          console.log(`🚚 Dados legados do grupo "${nomeGrupo}" migrados para o ID único ${groupId}`);
        }
      }

      let inativos = [];

      for (const participante of participantes) {
        const participanteId = participante.id._serialized;

        // Ignora o próprio bot e todos os administradores do grupo (para não listá-los como inativos)
        if (participanteId === client.info.wid._serialized) continue;
        if (participante.isAdmin || participante.isSuperAdmin) continue;

        const dadosUsuario = dadosGrupo[participanteId];

        if (!dadosUsuario) {
          inativos.push({
            id: participanteId,
            dias: '∞ (sem registro)'
          });
        } else {
          const ultimaMensagem = dayjs(dadosUsuario.ultimaMensagem);
          const diasInativo = agora.diff(ultimaMensagem, 'day');

          if (diasInativo >= dias) {
            inativos.push({
              id: participanteId,
              dias: `${diasInativo} dias`
            });
          }
        }
      }

      if (inativos.length === 0) {
        await chat.sendMessage(`✅ Nenhum membro inativo há ${dias} dias neste grupo!`);
        return;
      }

      // Define se vai enviar para o privado
      const enviarParaPV = forcarPV || (inativos.length > 10 && !forcarGrupo);

      // Carrega os contatos e prepara as menções
      let listaTexto = '';
      let mentions = [];

      for (const inativo of inativos) {
        try {
          const contato = await client.getContactById(inativo.id);
          mentions.push(contato.id._serialized);
          // Marcação real com @ no WhatsApp
          listaTexto += `• @${contato.id.user} - ${inativo.dias}\n`;
        } catch {
          const numLimpo = inativo.id.replace('@c.us', '').replace('@lid', '');
          listaTexto += `• @${numLimpo} - ${inativo.dias}\n`;
        }
      }

      if (enviarParaPV) {
        // Envia resumo no grupo
        await chat.sendMessage(`📋 *Membros Inativos:* Identifiquei *${inativos.length}* membros inativos há ${dias} dias.\n\nEnviei a lista detalhada com as marcações diretamente no seu privado para não poluir o grupo! 😉`);

        // Envia a lista completa no privado do admin
        const cabecalhoPV = `📊 *Relatório de Inativos — Grupo "${nomeGrupo}"*\n`;
        const corpoPV = `Aqui está a lista dos membros inativos há ${dias} dias:\n\n${listaTexto}\nTotal: ${inativos.length} inativo(s).`;

        await client.sendMessage(userId, cabecalhoPV + corpoPV, { mentions });
        console.log(`📩 Relatório enviado com sucesso para o privado do admin ${userId}`);
      } else {
        // Envia diretamente no grupo com menções reais
        const cabecalhoGrupo = `📋 *Membros inativos há ${dias} dias:*\n\n`;
        const rodapeGrupo = `\n📊 Total: ${inativos.length} membro(s) inativo(s)`;

        await chat.sendMessage(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
        console.log(`💬 Relatório enviado com sucesso no grupo "${nomeGrupo}"`);
      }

      return;
    }

    // ─── Comando /relatorio (Apenas Admins) ───
    if (corpo.split(' ')[0] === '/relatorio') {
      // Verifica se quem enviou é administrador do grupo ou o dono do bot
      let eAdmin = msg.fromMe;

      if (!eAdmin) {
        try {
          const contatoRemetente = await msg.getContact();
          const remetenteId = contatoRemetente.id._serialized;
          const participante = chat.participants.find(p =>
            p.id._serialized === remetenteId ||
            p.id._serialized === userId
          );
          if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
            eAdmin = true;
          }
        } catch (err) {
          console.error('⚠️ Erro ao verificar privilégios de admin:', err.message);
        }
      }

      if (!eAdmin) {
        console.log(`⛔ Comando /relatorio negado para ${userId} no grupo "${nomeGrupo}" (não é admin)`);
        await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo podem usar este comando!");
        return;
      }

      const partes = corpo.split(' ');
      const diasInatividade = parseInt(partes[1]) || 30; // Padrão: 30 dias para inativos
      const limiteFantasmas = parseInt(partes[2]) || 3;   // Padrão: 3 mensagens para observadores

      console.log(`📊 Comando /relatorio (inativos: ${diasInatividade} dias, limite msgs: ${limiteFantasmas}) recebido no grupo "${nomeGrupo}"`);

      // Mostra uma mensagem de "gerando..." no grupo para feedback visual
      const msgFeedback = await chat.sendMessage("⏳ *Aguarde:* Estou analisando o engajamento dos membros e gerando o relatório em formato de documento seguro...");

      try {
        const participantes = chat.participants;
        const agora = dayjs();
        const groupId = chat.id._serialized;
        let dadosGrupo = (atividade[groupId] && atividade[groupId].membros) || {};

        let elite = [];
        let observadores = [];
        let fantasmas = [];

        for (const participante of participantes) {
          const participanteId = participante.id._serialized;

          // Ignora o próprio bot e administradores
          if (participanteId === client.info.wid._serialized) continue;
          if (participante.isAdmin || participante.isSuperAdmin) continue;

          const dadosUsuario = dadosGrupo[participanteId];

          if (!dadosUsuario) {
            fantasmas.push({
              id: participanteId,
              motivo: 'Sem registro de mensagens'
            });
          } else {
            const totalMsg = dadosUsuario.totalMensagens || 0;
            const ultimaMsgDate = dayjs(dadosUsuario.ultimaMensagem);
            const diasInativo = agora.diff(ultimaMsgDate, 'day');

            // 1. É fantasma? (0 mensagens)
            if (totalMsg === 0) {
              fantasmas.push({
                id: participanteId,
                motivo: 'Membro no grupo com 0 mensagens registradas'
              });
            }
            // 2. É inativo por dias?
            else if (diasInativo >= diasInatividade) {
              fantasmas.push({
                id: participanteId,
                motivo: `Inativo há ${diasInativo} dias (Última msg: ${ultimaMsgDate.format('DD/MM/YYYY')})`
              });
            }
            // 3. É observador silencioso? (mensagens > 0 mas abaixo do limite e ativo recentemente)
            else if (totalMsg <= limiteFantasmas) {
              observadores.push({
                id: participanteId,
                mensagens: totalMsg,
                ultima: ultimaMsgDate.format('DD/MM/YYYY')
              });
            }
            // 4. É ativo (elite)
            else {
              elite.push({
                id: participanteId,
                mensagens: totalMsg
              });
            }
          }
        }

        // Ordena a elite por quantidade de mensagens
        elite.sort((a, b) => b.mensagens - a.mensagens);

        // Gera o conteúdo do arquivo TXT
        let relatorioConteudo = `============================================================\n`;
        relatorioConteudo += `📊 RELATÓRIO DE ENGAJAMENTO - GRUPO: ${nomeGrupo}\n`;
        relatorioConteudo += `📅 Gerado em: ${agora.format('DD/MM/YYYY')} às ${agora.format('HH:mm:ss')}\n`;
        relatorioConteudo += `============================================================\n\n`;

        relatorioConteudo += `🔥 MEMBROS ATIVOS (Mais Participativos):\n`;
        relatorioConteudo += `------------------------------------------------------------\n`;
        if (elite.length === 0) {
          relatorioConteudo += `(Nenhum membro ativo detectado além do limite de ${limiteFantasmas} mensagens)\n`;
        } else {
          elite.slice(0, 15).forEach((item, index) => {
            const numLimpo = item.id.replace('@c.us', '').replace('@lid', '');
            relatorioConteudo += `${index + 1}. ${numLimpo} - ${item.mensagens} mensagens\n`;
          });
          if (elite.length > 15) {
            relatorioConteudo += `... e mais ${elite.length - 15} membro(s) ativo(s) detalhado(s).\n`;
          }
        }
        relatorioConteudo += `\n`;

        relatorioConteudo += `🤫 OBSERVADORES (Membros Silenciosos - Pouca Interação):\n`;
        relatorioConteudo += `------------------------------------------------------------\n`;
        relatorioConteudo += `* Membros com até ${limiteFantasmas} mensagens no total:\n\n`;
        if (observadores.length === 0) {
          relatorioConteudo += `(Nenhum membro silencioso detectado)\n`;
        } else {
          observadores.forEach((item, index) => {
            const numLimpo = item.id.replace('@c.us', '').replace('@lid', '');
            relatorioConteudo += `${index + 1}. ${numLimpo} - ${item.mensagens} msg(s) | Última em: ${item.ultima}\n`;
          });
        }
        relatorioConteudo += `\n`;

        relatorioConteudo += `👻 FANTASMAS E INATIVOS (Recomendado para Remoção):\n`;
        relatorioConteudo += `------------------------------------------------------------\n`;
        relatorioConteudo += `* Membros com 0 mensagens ou inativos há ${diasInatividade}+ dias:\n\n`;
        if (fantasmas.length === 0) {
          relatorioConteudo += `(Nenhum membro fantasma ou inativo detectado)\n`;
        } else {
          fantasmas.forEach((item, index) => {
            const numLimpo = item.id.replace('@c.us', '').replace('@lid', '');
            relatorioConteudo += `${index + 1}. ${numLimpo} - ${item.motivo}\n`;
          });
        }
        relatorioConteudo += `\n`;

        relatorioConteudo += `============================================================\n`;
        relatorioConteudo += `📊 ESTATÍSTICAS GERAIS DO GRUPO:\n`;
        relatorioConteudo += `------------------------------------------------------------\n`;
        relatorioConteudo += `• Total de Participantes Analisados: ${participantes.length - 1}\n`;
        relatorioConteudo += `• Membros Ativos: ${elite.length}\n`;
        relatorioConteudo += `• Observadores (Silenciosos): ${observadores.length}\n`;
        relatorioConteudo += `• Inativos / Fantasmas: ${fantasmas.length}\n`;
        relatorioConteudo += `============================================================\n`;

        // Salva o arquivo localmente
        const nomeArquivo = `relatorio_${nomeGrupo.replace(/[^a-zA-Z0-9]/g, '_')}_${agora.format('YYYYMMDD_HHmmss')}.txt`;
        const caminhoLocal = `./relatorios/${nomeArquivo}`;

        // Garante que a pasta 'relatorios' exista
        await fs.ensureDir('./relatorios');
        await fs.writeFile(caminhoLocal, relatorioConteudo, 'utf-8');

        console.log(`💾 Relatório TXT gerado localmente em: ${caminhoLocal}`);

        // Envia o arquivo por WhatsApp para quem solicitou (no privado)
        const media = MessageMedia.fromFilePath(caminhoLocal);

        // Envia para o privado do admin que disparou o comando
        await client.sendMessage(userId, media, {
          caption: `📊 *Relatório de Engajamento — Grupo "${nomeGrupo}"*\n\nArquivo gerado de forma 100% segura sem gerar spam.\n\n📂 *Arquivo:* \`${nomeArquivo}\``,
          sendMediaAsDocument: true
        });

        // Edita a mensagem do grupo informando o sucesso
        await msgFeedback.edit(`✅ *Relatório gerado com sucesso!* 📂🔒`);
        console.log(`📩 Relatório em arquivo enviado no privado de ${userId}`);

      } catch (err) {
        console.error('❌ Erro ao gerar/enviar relatório:', err.message);
        await msgFeedback.edit(`⚠️ *Erro crítico ao gerar o relatório:* ${err.message}`);
      }

      return;
    }

    // ─── Registrar atividade do membro ───
    const groupId = chat.id._serialized;

    // Migração de dados legados ao gravar mensagens
    if (atividade[nomeGrupo] && !atividade[nomeGrupo].membros) {
      atividade[groupId] = {
        nomeGrupo: nomeGrupo,
        membros: atividade[nomeGrupo]
      };
      delete atividade[nomeGrupo];
    }

    if (!atividade[groupId]) {
      atividade[groupId] = {
        nomeGrupo: nomeGrupo,
        membros: {}
      };
    } else {
      // Atualiza o nome do grupo se ele tiver sido alterado
      atividade[groupId].nomeGrupo = nomeGrupo;
    }

    if (!atividade[groupId].membros[userId]) {
      atividade[groupId].membros[userId] = {
        ultimaMensagem: dayjs().format(),
        totalMensagens: 0
      };
    }

    atividade[groupId].membros[userId].ultimaMensagem = dayjs().format();
    atividade[groupId].membros[userId].totalMensagens += 1;

    await salvarAtividade(atividade);
    console.log(`✅ Salvo! ${userId} no grupo "${nomeGrupo}" (total: ${atividade[groupId].membros[userId].totalMensagens})`);

  } catch (err) {
    console.error('❌ Erro ao processar mensagem:', err.message);
    console.error(err.stack);
  }
}

// Controle para evitar processar a mesma mensagem 2x (ambos eventos podem disparar)
const mensagensProcessadas = new Set();

client.on('message', (msg) => {
  if (mensagensProcessadas.has(msg.id._serialized)) return;
  mensagensProcessadas.add(msg.id._serialized);
  // Limpa mensagens antigas a cada 1000 entradas
  if (mensagensProcessadas.size > 1000) mensagensProcessadas.clear();
  processarMensagem(msg, 'message');
});

client.on('message_create', (msg) => {
  if (mensagensProcessadas.has(msg.id._serialized)) return;
  mensagensProcessadas.add(msg.id._serialized);
  if (mensagensProcessadas.size > 1000) mensagensProcessadas.clear();
  processarMensagem(msg, 'message_create');
});

// Tratamento de erros globais para evitar crash
process.on('unhandledRejection', (err) => {
  console.error('⚠️ Erro não tratado (Promise):', err.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('⚠️ Erro não tratado (Exception):', err.message || err);
});

// Inicia o cliente
console.log('');
console.log('🤖 Bot WhatsApp - Verificador de Inativos');
console.log('==========================================');
console.log('⏳ Inicializando...');
console.log('');

client.initialize();
