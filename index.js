require('dotenv').config();
process.env.TZ = 'America/Sao_Paulo';
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const dayjs = require('dayjs');
const gemini = require('./src/geminiModeracao');
const {
  avaliarTexto,
  obterIdPrivadoRemetente,
  resolverParticipanteId,
  ehMensagemDeGrupo,
  resolverIdGrupo,
  deveProcessarMensagemAgora,
  parseComando,
  ehFigurinhaWhatsApp,
  deveAnalisarMidiaComIA,
  mimetypeEhFigurinha
} = require('./src/moderationRules');

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

function podarIdsProcessados(set, maxSize = 1000, keepSize = 500) {
  if (set.size <= maxSize) return;
  const manter = [...set].slice(-keepSize);
  set.clear();
  manter.forEach((id) => set.add(id));
}

function nomeGrupoNormalizado(nomeGrupo) {
  return (nomeGrupo || '').toLowerCase().replace(/[\s_]+/g, '_');
}

/** Grupos com moderação automática (igual server.js: Espada + Fd teste). */
function grupoEhModerado(nomeGrupo) {
  const n = nomeGrupoNormalizado(nomeGrupo);
  return (
    n.includes('espada_ruadaestacao') ||
    n.includes('espada_rua_da_estacao') ||
    n === 'fd'
  );
}

function grupoEhEspada(nomeGrupo) {
  const n = nomeGrupoNormalizado(nomeGrupo);
  return n.includes('espada');
}

const ultimosAvisosModeracao = {};

/**
 * Moderação anti-spam/ofensas + Gemini (texto e mídia).
 * @returns {boolean} true se puniu e não deve registrar atividade
 */
async function moderarConteudoGrupo(msg, chat, nomeGrupo, userId, corpo) {
  const { cmd: comando } = parseComando((corpo || '').trim());
  if (!grupoEhModerado(nomeGrupo) || msg.fromMe || comando) return false;

  let eAdmin = false;
  try {
    const participante = chat.participants.find((p) => p.id._serialized === userId);
    if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
      eAdmin = true;
    }
  } catch (err) {
    console.error('⚠️ Erro ao verificar admin na moderação:', err.message);
  }
  if (eAdmin) return false;

  if (msg.hasMedia && ehFigurinhaWhatsApp(msg)) {
    console.log(`🎭 [Moderador] Figurinha ignorada de ${userId}`);
    return false;
  }

  if (deveAnalisarMidiaComIA(msg)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const groupId = chat.id._serialized;
  const termosCustom =
    atividade[groupId]?.termosProibidos?.length > 0 ? atividade[groupId].termosProibidos : null;

  const avaliacao = avaliarTexto(corpo, {
    grupoEspada: grupoEhEspada(nomeGrupo),
    termosCustomizados: termosCustom || undefined
  });

  let contemSpam = !avaliacao.permitido;
  let motivoSpam = avaliacao.motivo || 'anúncio ou conteúdo proibido';

  if (avaliacao.permitido && avaliacao.camada === 'frase' && avaliacao.motivo) {
    console.log(`✅ [Moderador] Liberado: ${avaliacao.motivo}`);
  }

  const termoPainelSemIA =
    avaliacao.camada === 'custom' ||
    avaliacao.bloqueiaIA === true ||
    /termo proibido personalizado/i.test(String(motivoSpam || ''));

  if (contemSpam && termoPainelSemIA) {
    console.log(`🛡️ [Moderador] Bloqueio direto (sem IA): ${motivoSpam}`);
  }

  if (contemSpam && gemini.temChavesGemini() && !termoPainelSemIA) {
    console.log(`🤖 [Moderador IA] Verificando contexto: "${corpo.substring(0, 60)}"...`);
    const resultadoIA = await gemini.analisarTextoComIA(corpo);
    if (resultadoIA === 'FALHA') {
      console.warn('⚠️ [Moderador IA] Indisponível — mantém bloqueio por palavra-chave.');
    } else if (resultadoIA === 'NAO') {
      console.log(`✅ [Moderador IA] Liberado (falso positivo de "${motivoSpam}")`);
      contemSpam = false;
      motivoSpam = '';
    }
  }

  if (!contemSpam && deveAnalisarMidiaComIA(msg) && gemini.temChavesGemini()) {
    try {
      const media = await msg.downloadMedia();
      if (media) {
        if (mimetypeEhFigurinha(media.mimetype, msg)) {
          console.log('🎭 [Moderador IA] Figurinha ignorada após download');
        } else if (media.mimetype.startsWith('image/') || media.mimetype.startsWith('video/')) {
          const tamanhoMB = (media.data.length * 0.75) / (1024 * 1024);
          if (tamanhoMB > 10) {
            console.log(`⚠️ [Moderador IA] Mídia ignorada por tamanho (${tamanhoMB.toFixed(1)}MB)`);
          } else {
            const tipo = media.mimetype.startsWith('image/') ? 'imagem' : 'vídeo';
            console.log(`🤖 [Moderador IA] Analisando ${tipo} (${tamanhoMB.toFixed(2)}MB)...`);
            const resultadoIA = await gemini.analisarImagemComIA(media.data, media.mimetype);
            if (resultadoIA === 'SIM') {
              contemSpam = true;
              motivoSpam = `conteúdo visual impróprio (IA) no ${tipo}`;
            } else if (resultadoIA === 'FALHA') {
              console.warn(`⚠️ [Moderador IA] ${tipo} não analisada — Gemini indisponível.`);
            } else {
              console.log(`✅ [Moderador IA] ${tipo} liberada pela IA`);
            }
          }
        }
      }
    } catch (err) {
      console.error('⚠️ Falha ao analisar mídia com IA:', err.message);
    }
  }

  if (!contemSpam) return false;

  console.log(`🚨 SPAM/CONTEÚDO PROIBIDO de ${userId} em "${nomeGrupo}": ${motivoSpam}`);

  try {
    await msg.delete(true);
    console.log('🗑️ Mensagem apagada.');
  } catch (err) {
    console.error('❌ Erro ao apagar mensagem:', err.message);
  }

  if (!atividade[groupId]) {
    atividade[groupId] = { nomeGrupo, membros: {} };
  }
  if (!atividade[groupId].advertencias) atividade[groupId].advertencias = {};
  if (!atividade[groupId].advertencias[userId]) atividade[groupId].advertencias[userId] = 0;

  const agora = Date.now();
  const ultimo = ultimosAvisosModeracao[userId] || 0;
  if (agora - ultimo < 3000) return true;
  ultimosAvisosModeracao[userId] = agora;

  atividade[groupId].advertencias[userId] += 1;
  const advCount = atividade[groupId].advertencias[userId];
  await salvarAtividade(atividade);

  const contato = await msg.getContact();

  if (advCount >= 3) {
    try {
      await chat.removeParticipants([userId]);
      console.log(`🚫 Usuário ${userId} removido por 3 advertências.`);
      await chat.sendMessage(
        `🚫 @${contato.id.user} foi removido do grupo por atingir o limite de 3 advertências de conteúdo proibido.`,
        { mentions: [contato] }
      );
      delete atividade[groupId].advertencias[userId];
      await salvarAtividade(atividade);
    } catch (err) {
      console.error('❌ Erro ao remover usuário:', err.message);
      await chat.sendMessage(
        `⚠️ @${contato.id.user} deveria ser banido (3 advertências), mas o bot não tem permissão de admin.`,
        { mentions: [contato] }
      );
    }
  } else {
    await chat.sendMessage(
      `⚠️ @${contato.id.user}, conteúdo proibido neste grupo. Advertência (${advCount}/3). Mensagem apagada.`,
      { mentions: [contato] }
    );
  }

  return true;
}

// Inicializa o cliente WhatsApp com autenticação local (persiste sessão)
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: '/usr/bin/chromium-browser',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-features=site-per-process'
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
  const qtdGemini = gemini.getGeminiKeys().length;
  if (qtdGemini > 0) {
    console.log(
      `🤖 Gemini: ${qtdGemini} chave(s), modelos ${gemini.getGeminiModels().join(' → ')} — IA ativa na moderação`
    );
  } else {
    console.warn('⚠️ GEMINI_API_KEY não definida — moderação só por palavras (sem IA texto/mídia).');
  }
  console.log('🛡️ Moderação automática: Espada_ruadaestacao + grupo Fd (teste)');
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

    if (!ehMensagemDeGrupo(msg)) return;

    let chat = await msg.getChat();
    if (!chat?.isGroup) {
      const groupJid = resolverIdGrupo(msg);
      if (!groupJid) return;
      chat = await client.getChatById(groupJid);
    }
    if (!chat?.isGroup) return;

    // Log bruto para debug
    console.log(`🔔 [${eventoOrigem}] from: ${msg.from} | to: ${msg.to} | author: ${msg.author || 'N/A'} | grupo: ${chat.isGroup}`);

    const nomeGrupo = chat.name;
    const userId = resolverParticipanteId(msg, client);
    const idPrivadoRemetente = obterIdPrivadoRemetente(msg, userId, client);

    console.log(`💬 Mensagem no grupo "${nomeGrupo}" de ${userId} (pv: ${idPrivadoRemetente}): "${corpo.substring(0, 50)}"`);

    if (await moderarConteudoGrupo(msg, chat, nomeGrupo, userId, corpo)) {
      return;
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

      const msgAguarde = await chat.sendMessage('⏳ *Aguarde:* Analisando membros fantasmas...');

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
        try {
          await msgAguarde.edit(`✅ Todos os membros comuns têm mais de ${limite} mensagens! Nenhum fantasma detectado.`);
        } catch {
          await chat.sendMessage(`✅ Todos os membros comuns têm mais de ${limite} mensagens! Nenhum fantasma detectado.`);
        }
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
        const cabecalhoPV = `📊 *Membros com Pouca Interação — Grupo "${nomeGrupo}"*\n`;
        const corpoPV = `Estes membros enviaram menos de ${limite} mensagens desde o início do rastreamento:\n\n${listaTexto}\nTotal: ${fantasmas.length} fantasma(s).`;

        await client.sendMessage(idPrivadoRemetente, cabecalhoPV + corpoPV, { mentions });
        console.log(`📩 Relatório de fantasmas enviado para o privado de ${idPrivadoRemetente}`);

        try {
          await msgAguarde.edit(`✅ *Concluído* — ${fantasmas.length} fantasma(s) analisado(s). Lista enviada no privado.`);
        } catch {
          await chat.sendMessage(`✅ *Concluído* — ${fantasmas.length} fantasma(s) analisado(s). Lista enviada no privado.`);
        }
      } else {
        const cabecalhoGrupo = `👻 *Membros com Baixa Interação (Menos de ${limite} mensagens):*\n\n`;
        const rodapeGrupo = `\n📊 Total: ${fantasmas.length} fantasma(s) detectado(s).`;

        try {
          await msgAguarde.edit(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
        } catch {
          await chat.sendMessage(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
        }
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

      const msgAguardeInativos = await chat.sendMessage(`⏳ *Aguarde:* Analisando membros inativos há ${dias} dias...`);

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
        try {
          await msgAguardeInativos.edit(`✅ Nenhum membro inativo há ${dias} dias neste grupo!`);
        } catch {
          await chat.sendMessage(`✅ Nenhum membro inativo há ${dias} dias neste grupo!`);
        }
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
        const cabecalhoPV = `📊 *Relatório de Inativos — Grupo "${nomeGrupo}"*\n`;
        const corpoPV = `Aqui está a lista dos membros inativos há ${dias} dias:\n\n${listaTexto}\nTotal: ${inativos.length} inativo(s).`;

        await client.sendMessage(idPrivadoRemetente, cabecalhoPV + corpoPV, { mentions });
        console.log(`📩 Relatório enviado com sucesso para o privado do admin ${idPrivadoRemetente}`);

        try {
          await msgAguardeInativos.edit(`✅ *Concluído* — ${inativos.length} inativo(s) analisado(s). Lista enviada no privado.`);
        } catch {
          await chat.sendMessage(`✅ *Concluído* — ${inativos.length} inativo(s) analisado(s). Lista enviada no privado.`);
        }
      } else {
        const cabecalhoGrupo = `📋 *Membros inativos há ${dias} dias:*\n\n`;
        const rodapeGrupo = `\n📊 Total: ${inativos.length} membro(s) inativo(s)`;

        try {
          await msgAguardeInativos.edit(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
        } catch {
          await chat.sendMessage(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
        }
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
        await client.sendMessage(idPrivadoRemetente, media, {
          caption: `📊 *Relatório de Engajamento — Grupo "${nomeGrupo}"*\n\nArquivo gerado de forma 100% segura sem gerar spam.\n\n📂 *Arquivo:* \`${nomeArquivo}\``,
          sendMediaAsDocument: true
        });

        // Edita a mensagem do grupo informando o sucesso
        await msgFeedback.edit(`✅ *Relatório gerado com sucesso!* 📂🔒`);
        console.log(`📩 Relatório em arquivo enviado no privado de ${idPrivadoRemetente}`);

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

client.on('message_create', (msg) => {
  if (!deveProcessarMensagemAgora(msg)) return;
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
