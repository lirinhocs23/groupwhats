require('dotenv').config();
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
const ffmpeg = require('fluent-ffmpeg');
const os = require('os');
const crypto = require('crypto');
const {
  normalizarTextoParaFiltro,
  avaliarTexto,
  PROMPT_REGRAS_GRUPO,
  resolverParticipanteId,
  resolverIdGrupo,
  ehMensagemDeGrupo,
  obterIdPrivadoRemetente,
  deveProcessarMensagemAgora,
  parseComando,
  ehFigurinhaWhatsApp,
  deveAnalisarMidiaComIA,
  mimetypeEhFigurinha
} = require('./src/moderationRules');

// Buffer de logs na memória para depuração remota rápida do SaaS
const debugLogs = [];
const originalLog = console.log;
const originalError = console.error;

console.log = function(...args) {
  originalLog.apply(console, args);
  const dataHora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  debugLogs.push(`[${dataHora}] [LOG] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  if (debugLogs.length > 500) debugLogs.shift();
};

console.error = function(...args) {
  originalError.apply(console, args);
  const dataHora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  debugLogs.push(`[${dataHora}] [ERROR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  if (debugLogs.length > 500) debugLogs.shift();
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  const csp = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; font-src * data: blob: 'unsafe-inline';";
  res.setHeader('Content-Security-Policy', csp);
  next();
});
app.use(cors());
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
  );
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Mapa para manter as instâncias ativas do WhatsApp na memória
// Estrutura: { [usuarioId]: { client: Client, status: string, qr: string, numero: string } }
const sessoesAtivas = {};

// Controle Anti-Spam e Concorrência (deduplicação de mensagens em moderationRules.deveProcessarMensagemAgora)
const ultimosAvisosEnviados = {}; // { [participanteId]: timestamp }
const usuariosSendoRemovidos = new Set();
let delecaoEmAndamento = false;
const filaDelecao = [];

// Sistema de Rodízio de Chaves da API do Gemini (GEMINI_API_KEY=chave1,chave2,chave3)
let currentGeminiKeyIndex = 0;

function getGeminiModels() {
  const primary = (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim();
  const fallback = (process.env.GEMINI_MODEL_FALLBACK || 'gemini-2.0-flash').trim();
  const models = [primary];
  if (fallback && fallback !== primary) models.push(fallback);
  return models;
}

function urlGeminiModel(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function getGeminiKeys() {
  const envKey = process.env.GEMINI_API_KEY;
  if (!envKey) return [];
  return envKey.split(',').map((k) => k.trim()).filter(Boolean);
}

function temChavesGemini() {
  return getGeminiKeys().length > 0;
}

/** Compatibilidade: retorna uma chave do rodízio (preferir chamarGeminiComRotacaoChaves). */
function getNextGeminiKey() {
  const keys = getGeminiKeys();
  if (keys.length === 0) return null;
  const key = keys[currentGeminiKeyIndex % keys.length];
  currentGeminiKeyIndex++;
  return key;
}

/** Retry na mesma chave (503/5xx). 429/quota → troca de chave. */
const GEMINI_RETRY_HTTP = new Set([500, 503, 504]);
const GEMINI_MAX_TENTATIVAS = parseInt(process.env.GEMINI_RETRY_MAX || '3', 10);
const GEMINI_RETRY_BASE_MS = parseInt(process.env.GEMINI_RETRY_DELAY_MS || '1500', 10);

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mascararChaveGemini(apiKey) {
  if (!apiKey || apiKey.length < 8) return '****';
  return `...${apiKey.slice(-4)}`;
}

function geminiDeveTrocarChave(status, errData) {
  if (status === 429) return true;
  if (status === 403) return true;
  const raw = JSON.stringify(errData || {}).toLowerCase();
  return (
    raw.includes('quota') ||
    raw.includes('resource_exhausted') ||
    raw.includes('rate limit') ||
    raw.includes('rate_limit') ||
    raw.includes('too many requests') ||
    raw.includes('billing') ||
    raw.includes('limit exceeded') ||
    raw.includes('exceeded your')
  );
}

async function fetchGeminiUmaTentativa(apiKey, payload, timeoutMs, model) {
  const url = `${urlGeminiModel(model)}?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timer);

    if (res.ok) return { ok: true, res };

    let errData = null;
    try {
      errData = await res.json();
    } catch {
      errData = null;
    }
    return { ok: false, status: res.status, errData };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Retry + rotação de chaves para um modelo Gemini.
 * @returns {Promise<Response|{ ok: false, status: number, errData: object|null }>}
 */
async function chamarGeminiComRotacaoChavesComModelo(payload, timeoutMs, model) {
  const keys = getGeminiKeys();
  if (keys.length === 0) {
    return { ok: false, status: 0, errData: { error: 'GEMINI_API_KEY não configurada' } };
  }

  let ultimoStatus = 0;
  let ultimoErroJson = null;
  const startIdx = currentGeminiKeyIndex % keys.length;

  for (let ki = 0; ki < keys.length; ki++) {
    const keySlot = (startIdx + ki) % keys.length;
    const apiKey = keys[keySlot];
    const label = mascararChaveGemini(apiKey);

    for (let tentativa = 1; tentativa <= GEMINI_MAX_TENTATIVAS; tentativa++) {
      try {
        const resultado = await fetchGeminiUmaTentativa(apiKey, payload, timeoutMs, model);

        if (resultado.ok) {
          currentGeminiKeyIndex = (keySlot + 1) % keys.length;
          if (ki > 0) {
            console.log(`✅ Gemini [${model}] respondeu com chave alternativa ${label} (${ki + 1}/${keys.length}).`);
          }
          return resultado.res;
        }

        ultimoStatus = resultado.status;
        ultimoErroJson = resultado.errData;

        if (resultado.status === 400) {
          console.error(`❌ Gemini [${model}] pedido inválido (HTTP 400) chave ${label}:`, JSON.stringify(ultimoErroJson));
          return { ok: false, status: resultado.status, errData: ultimoErroJson };
        }

        if (geminiDeveTrocarChave(resultado.status, resultado.errData)) {
          console.warn(
            `🔑 Gemini [${model}] chave ${label}: cota/limite (HTTP ${resultado.status}). ` +
              `Trocando para outra chave (${ki + 1}/${keys.length})...`
          );
          break;
        }

        if (GEMINI_RETRY_HTTP.has(resultado.status) && tentativa < GEMINI_MAX_TENTATIVAS) {
          const espera = GEMINI_RETRY_BASE_MS * tentativa;
          console.warn(
            `⚠️ Gemini [${model}] HTTP ${resultado.status} chave ${label} ` +
              `(tentativa ${tentativa}/${GEMINI_MAX_TENTATIVAS}). Retry em ${espera}ms...`
          );
          await sleepMs(espera);
          continue;
        }

        if (ki < keys.length - 1) {
          console.warn(`⚠️ Gemini HTTP ${resultado.status} chave ${label}. Tentando próxima chave...`);
          break;
        }

        return { ok: false, status: resultado.status, errData: resultado.errData };
      } catch (err) {
        if (tentativa < GEMINI_MAX_TENTATIVAS) {
          const espera = GEMINI_RETRY_BASE_MS * tentativa;
          console.warn(
            `⚠️ Gemini rede/timeout chave ${label} (${tentativa}/${GEMINI_MAX_TENTATIVAS}): ${err.message}`
          );
          await sleepMs(espera);
          continue;
        }
        if (ki < keys.length - 1) {
          console.warn(`⚠️ Gemini falhou chave ${label}. Tentando próxima chave...`);
          break;
        }
        throw err;
      }
    }
  }

  currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % keys.length;
  console.error(
    `❌ Gemini [${model}]: todas as ${keys.length} chave(s) falharam. Último HTTP ${ultimoStatus}:`,
    JSON.stringify(ultimoErroJson || {})
  );
  return { ok: false, status: ultimoStatus, errData: ultimoErroJson };
}

/**
 * Chama o Gemini com retry, rotação de chaves e modelo reserva se o principal estiver em 503.
 */
async function chamarGeminiComRotacaoChaves(payload, timeoutMs = 25000) {
  const models = getGeminiModels();
  let ultimoErro = { ok: false, status: 0, errData: null };

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const resultado = await chamarGeminiComRotacaoChavesComModelo(payload, timeoutMs, model);

    if (resultado.ok) {
      if (mi > 0) {
        console.log(`✅ Gemini respondeu com modelo reserva: ${model}`);
      }
      return resultado;
    }

    ultimoErro = resultado;
    const retryable = [429, 500, 503, 504].includes(resultado.status);

    if (mi < models.length - 1 && retryable) {
      console.warn(
        `⚠️ Modelo ${model} indisponível (HTTP ${resultado.status}). ` +
          `Tentando modelo reserva ${models[mi + 1]}...`
      );
    }
  }

  return ultimoErro;
}

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
      args: (() => {
        const baseArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling'
        ];
        // --single-process e --no-zygote causam crashes imediatos do Chromium no Windows
        if (process.platform !== 'win32') {
          baseArgs.push('--disable-dev-shm-usage');
          baseArgs.push('--no-zygote');
          baseArgs.push('--single-process');
        }
        return baseArgs;
      })()
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

  // message_create inclui mensagens enviadas pelo dono da sessão (fromMe); "message" sozinho não
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
 * Analisa uma imagem ou vídeo em base64 usando a API do Gemini 1.5 Flash.
 */
async function analisarImagemComIA(base64Data, mimeType) {
  try {
    const parts = [
      {
        text: "Você é um moderador extremamente rigoroso de grupo de WhatsApp.\n" +
          "Analise os frames do vídeo ou a imagem enviada. Você DEVE decidir se a imagem viola as regras do grupo.\n\n" +
          "Regras Proibidas (responda true se houver alguma delas):\n" +
          "1. ACIDENTES OU CARROS BATIDOS: Qualquer colisão de trânsito, carro amassado/batido, capotamento, atropelamento, viaturas de resgate ou pessoas acidentadas.\n" +
          "2. JOGOS DE AZAR / APOSTAS: Panfletos de cassino, robô do pix, apostas esportivas ou promessas de dinheiro fácil.\n" +
          "3. PROPAGANDAS, SERVIÇOS E VENDAS: Anúncios de venda de carros, motos, rifas, cursos, serviços de TV/IPTV/streaming (como Netflix, HBO, Disney+, Prime Video, etc.), panfletos comerciais de qualquer comércio ou imagens promocionais que divulguem vendas ou contratação de serviços.\n\n" +
          "Regras Permitidas (responda false se for apenas isso):\n" +
          "- Cultura de espadas de fogo juninas, pessoas soltando fogos de artifício artesanais, fogueiras, cartazes de festas de São João locais, fotos normais do dia a dia dos membros ou conversas normais.\n\n" +
          "Você DEVE responder estritamente com um objeto JSON válido, contendo duas propriedades:\n" +
          "{\n" +
          "  \"raciocinio\": \"Sua justificativa em português descrevendo o que você vê na imagem e por que ela é proibida ou permitida.\",\n" +
          "  \"proibido\": true ou false\n" +
          "}"
      }
    ];

    if (mimeType.startsWith('video/')) {
      console.log(`⏳ [Moderador IA] Vídeo detectado. Extraindo 3 frames (início, meio, fim) com FFmpeg para garantir precisão...`);
      const buffer = Buffer.from(base64Data, 'base64');
      const tmpDir = os.tmpdir();
      const id = crypto.randomUUID();
      const videoPath = path.join(tmpDir, `${id}.mp4`);

      try {
        fs.writeFileSync(videoPath, buffer);
        
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .screenshots({
              timestamps: ['25%', '50%', '75%'], // Pega começo, meio e fim
              filename: `${id}_%i.jpg`,
              folder: tmpDir
            })
            .on('end', resolve)
            .on('error', err => {
              console.error(`⚠️ FFmpeg falhou ao extrair frames:`, err.message);
              reject(err);
            });
        });
        
        console.log(`✅ [Moderador IA] Frames extraídos! Enviando fotos para o Gemini Flash...`);
        for (let i = 1; i <= 3; i++) {
          const framePath = path.join(tmpDir, `${id}_${i}.jpg`);
          if (fs.existsSync(framePath)) {
            const frameBuffer = fs.readFileSync(framePath);
            parts.push({
              inlineData: { mimeType: 'image/jpeg', data: frameBuffer.toString('base64') }
            });
            fs.unlinkSync(framePath); // Limpa imagem logo após ler
          }
        }
      } finally {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath); // Delete video file
        // Cleanup any temporary frame images left over
        fs.readdirSync(tmpDir).filter(f => f.startsWith(id + '_') && f.endsWith('.jpg')).forEach(f => {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch (e) { console.error('Failed to delete temp frame', f, e); }
        });
        // Additional cleanup: delete any leftover PNG files in tmpDir for this message
        fs.readdirSync(tmpDir).filter(f => f.startsWith(id + '_') && f.endsWith('.png')).forEach(f => {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch (e) { console.error('Failed to delete temp PNG', f, e); }
        });
      }
    } else {
      // Imagens podem ir via inlineData rapidamente
      parts.push({
        inlineData: { mimeType: mimeType, data: base64Data }
      });
    }

    const payload = {
      contents: [{ parts: parts }],
      generationConfig: {
        responseMimeType: "application/json"
      },
      safetySettings: [
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" }
      ]
    };

    const res = await chamarGeminiComRotacaoChaves(payload, 25000);

    if (!res.ok) {
      return 'FALHA';
    }

    const data = await res.json();
    
    // Verifica se a resposta foi bloqueada pelos filtros de segurança do Google
    if (data.promptFeedback && data.promptFeedback.blockReason) {
      console.warn(`⚠️ IA bloqueou a análise por motivo de segurança: ${data.promptFeedback.blockReason}`);
      return 'SIM'; 
    }
    if (data.candidates && data.candidates[0] && data.candidates[0].finishReason === 'SAFETY') {
      console.warn(`⚠️ Resposta da IA bloqueada por conter cenas muito pesadas/violentas (SAFETY).`);
      return 'SIM'; // O vídeo continha violência pesada.
    }

    const textoOriginal = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    try {
      const parsed = JSON.parse(textoOriginal.trim());
      console.log(`🧠 [Moderador IA] Análise: "${parsed.raciocinio}" | Proibido: ${parsed.proibido}`);
      return parsed.proibido ? 'SIM' : 'NAO';
    } catch (parseErr) {
      console.warn(`⚠️ Falha ao processar JSON da IA, usando fallback de texto bruto: "${textoOriginal.trim()}"`);
      // Fallback robusto usando regex de palavra inteira (\b)
      const textoUpper = textoOriginal.toUpperCase();
      if (/\bSIM\b/.test(textoUpper) || /\bTRUE\b/.test(textoUpper)) {
        return 'SIM';
      }
      return 'NAO';
    }
  } catch (err) {
    console.error('⚠️ Erro na análise de visão do Gemini:', err.message);
    return 'FALHA';
  }
}

/**
 * Analisa o contexto de um texto usando a API do Gemini 1.5 Flash.
 * Utilizado para desempatar falsos positivos de palavras-chave.
 */
async function analisarTextoComIA(texto) {
  try {
    const payload = {
      contents: [
        {
          parts: [
            {
              text: `${PROMPT_REGRAS_GRUPO}

Um membro enviou a seguinte mensagem de texto:
"${texto}"

Analise a INTENÇÃO da mensagem acima.
Responda ESTRITAMENTE apenas com a palavra SIM se a mensagem violar as regras (spam, aposta, rifa, violência real fora de contexto, golpe).
Responda ESTRITAMENTE apenas com a palavra NAO se for conversa normal, gíria ("morreu de rir"), compra do dia a dia ("comprar pão") ou anúncio de espadas/acessórios.`
            }
          ]
        }
      ]
    };

    const res = await chamarGeminiComRotacaoChaves(payload, 20000);

    if (!res.ok) {
      return 'FALHA';
    }

    const data = await res.json();
    const textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text?.toUpperCase() || 'NAO';
    return textoResposta.includes('SIM') ? 'SIM' : 'NAO';
  } catch (err) {
    console.error('⚠️ Erro na análise de texto do Gemini:', err.message);
    return 'FALHA';
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

function erroSessaoFechada(err) {
  const msg = (err && err.message) ? String(err.message) : String(err || '');
  return (
    msg.includes('Target closed') ||
    msg.includes('detached Frame') ||
    msg.includes('Protocol error (Runtime.callFunctionOn)')
  );
}

async function limparRelatoriosAntigos(horas = 8) {
  const dir = path.join(__dirname, 'relatorios');
  const agora = Date.now();
  const limiteMs = Math.max(1, horas) * 60 * 60 * 1000;

  try {
    if (!fs.existsSync(dir)) return;
    const itens = fs.readdirSync(dir);
    for (const nome of itens) {
      const p = path.join(dir, nome);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        if (agora - st.mtimeMs > limiteMs) fs.unlinkSync(p);
      } catch (e) {
        console.warn('⚠️ Falha ao podar relatório antigo:', nome, e.message);
      }
    }
  } catch (err) {
    console.warn('⚠️ Falha ao limpar relatorios antigos:', err.message);
  }
}

/** Atualiza a mensagem "Aguarde..." após enviar resultado no PV (com fallback se edit falhar). */
async function concluirMensagemAguarde(msgFeedback, chat, texto) {
  if (!msgFeedback) {
    await chat.sendMessage(texto);
    return;
  }
  try {
    await msgFeedback.edit(texto);
  } catch (err) {
    console.warn('⚠️ Falha ao editar mensagem de aguarde:', err.message);
    try {
      await chat.sendMessage(texto);
    } catch (e) {
      console.error('⚠️ Falha ao enviar conclusão no grupo:', e.message);
    }
  }
}

/**
 * Processamento interno para salvar logs de mensagens recebidas/criadas
 */
async function processarMensagemEntrada(usuarioId, client, msg) {
  try {
    if (!deveProcessarMensagemAgora(msg)) return;

    // Grupos: from = @g.us (recebidas) ou to = @g.us quando fromMe (enviadas pelo dono da sessão)
    if (!ehMensagemDeGrupo(msg)) return;

    let chat = await msg.getChat();
    if (!chat?.isGroup) {
      const groupJid = resolverIdGrupo(msg);
      if (!groupJid) return;
      chat = await client.getChatById(groupJid);
    }
    if (!chat?.isGroup) return;

    const groupId = chat.id._serialized;
    const nomeGrupo = chat.name;
      let participanteId = resolverParticipanteId(msg, client);

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

      const corpo = (msg.body || '').trim();
      const { cmd: comando, texto: corpoCmd } = parseComando(corpo);
      console.log(`📥 [RECEBIDA] Grupo: "${nomeGrupo}", Membro: ${participanteId}, fromMe: ${msg.fromMe}, cmd: ${comando || '-'}, texto: "${corpo.substring(0, 50)}"`);

      const idPrivadoRemetente = obterIdPrivadoRemetente(msg, participanteId, client);

      // ─── COMANDOS DO BOT MULTI-TENANT (SaaS) ───
      if (comando) {
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
        if (comando === '/ajuda') {
          const textoAjuda = `🤖 *Comandos do Bot de Gestão de Grupos - NL Tecnologias:*\n\n` +
            `📊 *Gestão & Engajamento:* (Para Administradores)\n` +
            `• \`/fantasmas [limite] [pv|gp]\` - Lista membros com menos de [limite] mensagens (padrão: 3).\n` +
            `• \`/inativos [dias] [pv|gp]\` - Lista membros sem mensagens há [dias] dias (padrão: 30).\n` +
            `• \`/relatorio [dias] [limite]\` - Envia no privado um relatório em arquivo TXT completo.\n\n` +
            `🚫 *Moderação:* (Administradores do grupo)\n` +
            `• \`/ban @membro\` - Remove o membro mencionado.\n` +
            `• \`/baninativo @membro\` - Remove o membro mencionado por inatividade.\n\n` +
            `💡 *Observação:* Se escolher o modo \`pv\`, a lista com as menções será enviada diretamente no seu privado para discrição!`;
          await chat.sendMessage(textoAjuda);
          return;
        }

        // 2. Comandos de Ban / BanInativo (Administradores do grupo ou dono da sessão)
        if (comando === '/ban' || comando === '/baninativo') {
          if (!eAdmin) {
            const contaBot = client.info?.wid?.user || 'desconhecida';
            await chat.sendMessage(
              `⚠️ *Sem permissão:* Apenas administradores deste grupo podem usar \`${comando}\`.\n\n` +
              `📱 Conta conectada ao bot no painel: *${contaBot}*\n` +
              `Se você é o dono do bot, envie o comando com esse número no WhatsApp.`
            );
            console.log(`⛔ Comando ${comando} negado para ${participanteId} no grupo "${nomeGrupo}" (não é admin)`);
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
            const partes = corpoCmd.split(/\s+/);
            const numero = partes[1] ? partes[1].replace(/\D/g, '') : '';
            if (numero) {
              targetId = `${numero}@c.us`;
            }
          }

          if (!targetId) {
            const cmdName = comando === '/baninativo' ? '/baninativo' : '/ban';
            await chat.sendMessage(`⚠️ *Uso correto:* \`${cmdName} @membro\` ou \`${cmdName} 5511999999999\``);
            return;
          }

          try {
            const contatoAlvo = await client.getContactById(targetId);
            const realId = contatoAlvo.id._serialized;
            await chat.removeParticipants([realId]);
            const msgBan = comando === '/baninativo'
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
        if (comando === '/fantasmas') {
          if (!eAdmin) {
            await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo ou o dono do bot podem usar este comando!");
            return;
          }

          const partes = corpoCmd.split(/\s+/);
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
              const cabecalhoPV = `📊 *Membros com Pouca Interação — Grupo "${nomeGrupo}"*\n`;
              const corpoPV = `Estes membros enviaram menos de ${limite} mensagens:\n\n${listaTexto}\nTotal: ${fantasmas.length} fantasma(s).`;
              await client.sendMessage(idPrivadoRemetente, cabecalhoPV + corpoPV, { mentions });
              await concluirMensagemAguarde(
                msgFeedback,
                chat,
                `✅ *Concluído* — ${fantasmas.length} fantasma(s) analisado(s). Lista enviada no privado.`
              );
            } else {
              const cabecalhoGrupo = `👻 *Membros com Baixa Interação (Menos de ${limite} mensagens):*\n\n`;
              const rodapeGrupo = `\n📊 Total: ${fantasmas.length} fantasma(s) detectado(s).`;
              await msgFeedback.edit(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
            }
          } catch (err) {
            console.error('❌ Erro no comando /fantasmas:', err.message);
            await concluirMensagemAguarde(msgFeedback, chat, `⚠️ *Erro ao analisar fantasmas:* ${err.message}`);
          }
          return;
        }

        // 4. Comando /inativos [dias] [pv|gp] (Admins e Dono)
        if (comando === '/inativos') {
          if (!eAdmin) {
            await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo ou o dono do bot podem usar este comando!");
            return;
          }

          const partes = corpoCmd.split(/\s+/);
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
              const cabecalhoPV = `📊 *Relatório de Inativos — Grupo "${nomeGrupo}"*\n`;
              const corpoPV = `Aqui está a lista dos membros inativos há ${dias} dias:\n\n${listaTexto}\nTotal: ${inativos.length} inativo(s).`;
              await client.sendMessage(idPrivadoRemetente, cabecalhoPV + corpoPV, { mentions });
              await concluirMensagemAguarde(
                msgFeedback,
                chat,
                `✅ *Concluído* — ${inativos.length} inativo(s) analisado(s). Lista enviada no privado.`
              );
            } else {
              const cabecalhoGrupo = `📋 *Membros inativos há ${dias} dias:*\n\n`;
              const rodapeGrupo = `\n📊 Total: ${inativos.length} membro(s) inativo(s)`;
              await msgFeedback.edit(cabecalhoGrupo + listaTexto + rodapeGrupo, { mentions });
            }
          } catch (err) {
            console.error('❌ Erro no comando /inativos:', err.message);
            await concluirMensagemAguarde(msgFeedback, chat, `⚠️ *Erro ao analisar inativos:* ${err.message}`);
          }
          return;
        }

        // 5. Comando /relatorio [dias] [limite] (Admins e Dono)
        if (comando === '/relatorio') {
          if (!eAdmin) {
            await chat.sendMessage("⚠️ *Erro:* Apenas administradores do grupo ou o dono do bot podem usar este comando!");
            return;
          }

          const partes = corpoCmd.split(/\s+/);
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
            await client.sendMessage(idPrivadoRemetente, media, {
              caption: `📊 *Relatório de Engajamento — Grupo "${nomeGrupo}"*\n\nArquivo gerado de forma 100% segura.\n\n📂 *Arquivo:* \`${nomeArquivo}\``,
              sendMediaAsDocument: true
            });

            // Libera espaço no volume (Railway free) — remove arquivo e poda relatórios antigos
            try { await fs.unlink(caminhoLocal); } catch (e) { console.warn('⚠️ Falha ao apagar relatório local:', e.message); }
            await limparRelatoriosAntigos(8);

            await concluirMensagemAguarde(
              msgFeedback,
              chat,
              '✅ *Concluído* — relatório gerado e enviado no privado.'
            );
          } catch (err) {
            console.error('❌ Erro ao gerar/enviar relatório:', err.message);
            await concluirMensagemAguarde(msgFeedback, chat, `⚠️ *Erro ao gerar relatório:* ${err.message}`);
          }
          return;
        }
      }



      // ─── MODERADOR AUTOMÁTICO ANTI-SPAM / ANÚNCIOS ───
      const nomeGrupoLimpo = nomeGrupo.toLowerCase().replace(/[\s_]+/g, '_');
      const dbModeracao = await database.lerDB();
      const grupoConfigEarly = dbModeracao.atividade[usuarioId] && dbModeracao.atividade[usuarioId][groupId];
      const temTermosNoPainel = !!(grupoConfigEarly && grupoConfigEarly.termosProibidos && grupoConfigEarly.termosProibidos.length > 0);
      const moderacaoExplicita = !!(grupoConfigEarly && grupoConfigEarly.moderacaoAtiva);
      const isGrupoModerado =
        nomeGrupoLimpo.includes('espada_ruadaestacao') ||
        nomeGrupoLimpo.includes('espada_rua_da_estacao') ||
        nomeGrupoLimpo === 'fd' ||
        moderacaoExplicita ||
        temTermosNoPainel;

      const isGrupoEspada =
        nomeGrupoLimpo.includes('espada_ruadaestacao') ||
        nomeGrupoLimpo.includes('espada_rua_da_estacao') ||
        nomeGrupoLimpo.includes('espada');

      if (isGrupoModerado && !msg.fromMe && !comando) {
        let eAdmin = false;
        try {
          const participante = chat.participants.find(p => p.id._serialized === participanteId);
          if (participante && (participante.isAdmin || participante.isSuperAdmin)) {
            eAdmin = true;
          }
        } catch (e) {
          console.error('⚠️ Erro ao verificar privilégios no Moderador SaaS:', e.message);
        }

        console.log(`👤 [DEBUG] Verificação de Admin no grupo "${nomeGrupo}" para o remetente ${participanteId}: eAdmin = ${eAdmin}`);

        if (!eAdmin) {
          if (msg.hasMedia && ehFigurinhaWhatsApp(msg)) {
            console.log(`🎭 [Moderador] Figurinha ignorada (sem IA) de ${participanteId}`);
          }

          // Só aguarda metadados para imagem/vídeo que serão analisados (não figurinha)
          if (deveAnalisarMidiaComIA(msg)) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }

          const grupoConfig = grupoConfigEarly;
          const termosCustomizados = (grupoConfig && grupoConfig.termosProibidos && grupoConfig.termosProibidos.length > 0)
            ? grupoConfig.termosProibidos
            : null;

          const avaliacao = avaliarTexto(corpo, {
            termosCustomizados: termosCustomizados || undefined,
            grupoEspada: isGrupoEspada
          });

          let contemSpam = !avaliacao.permitido;
          let motivoSpam = avaliacao.motivo || 'anúncio ou conteúdo proibido';

          if (avaliacao.permitido && avaliacao.camada === 'frase' && avaliacao.motivo) {
            const nomeParticipante = msg._data.notifyName || participanteId.split('@')[0];
            io.to(usuarioId).emit('log_seguranca', {
              data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
              grupo: nomeGrupo,
              membro: participanteId.split('@')[0],
              nome: nomeParticipante,
              acao: 'ALLOW',
              motivo: avaliacao.motivo
            });
          }

          if (contemSpam && temChavesGemini() && !avaliacao.bloqueiaIA) {
            console.log(`🤖 [Moderador IA] Verificando contexto do texto de ${participanteId} com Gemini para evitar falso positivo...`);
            const resultadoIA = await analisarTextoComIA(corpo);
            if (resultadoIA === 'FALHA') {
              console.warn(`⚠️ [Moderador IA] Texto não revalidado pela IA (indisponível). Mantém bloqueio por palavra-chave.`);
            } else if (resultadoIA === 'NAO') {
              // Liberado pela IA (Era uma conversa normal ou gíria)
              const nomeParticipante = msg._data.notifyName || participanteId.split('@')[0];
              io.to(usuarioId).emit('log_seguranca', {
                data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                grupo: nomeGrupo,
                membro: participanteId.split('@')[0],
                nome: nomeParticipante,
                acao: 'ALLOW',
                motivo: `Texto liberado pela IA de contexto. (Falso positivo de "${motivoSpam}")`
              });
              contemSpam = false; // Desfaz a acusação de spam
              motivoSpam = '';
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
          if (!contemSpam && deveAnalisarMidiaComIA(msg)) {
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

            // Apenas registramos no console e prosseguimos para a análise de IA, permitindo
            // mídias da tradição passarem caso sejam legítimas
            if (isForwarded) {
              console.log(`ℹ️ [SaaS Moderador] Mídia encaminhada detectada. Enviando para análise de IA.`);
            }
          }

          // 4. Análise por IA: apenas imagem ou vídeo (figurinhas são ignoradas)
          const usarGeminiMidia = !contemSpam && deveAnalisarMidiaComIA(msg) && temChavesGemini();
          if (usarGeminiMidia) {
            try {
              const media = await msg.downloadMedia();
              if (media) {
                if (mimetypeEhFigurinha(media.mimetype, msg)) {
                  console.log(`🎭 [Moderador IA] Figurinha/webp de pacote ignorada após download (${media.mimetype})`);
                } else if (media.mimetype.startsWith('image/') || media.mimetype.startsWith('video/')) {
                  // Estima o tamanho a partir do base64 (3/4 do comprimento da string base64)
                  const tamanhoMB = (media.data.length * 0.75) / (1024 * 1024);
                  
                  if (tamanhoMB > 10) {
                    console.log(`⚠️ [Moderador IA] Mídia de ${participanteId} ignorada por tamanho excessivo (${tamanhoMB.toFixed(2)}MB > 10MB)`);
                    io.to(usuarioId).emit('log_seguranca', {
                      data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                      grupo: nomeGrupo,
                      membro: participanteId.split('@')[0],
                      nome: msg._data.notifyName || 'Membro',
                      acao: 'ALLOW',
                      motivo: `Mídia (${media.mimetype.startsWith('image/') ? 'imagem' : 'vídeo'}) ignorada por tamanho excessivo (${tamanhoMB.toFixed(2)}MB > 10MB)`
                    });
                  } else {
                    const tipoMidia = media.mimetype.startsWith('image/') ? 'imagem' : 'vídeo';
                    console.log(`🤖 [Moderador IA] Analisando ${tipoMidia} de ${participanteId} (${tamanhoMB.toFixed(2)}MB) com Gemini Vision...`);
                    
                    const resultadoIA = await analisarImagemComIA(media.data, media.mimetype);
                    
                    if (resultadoIA === 'SIM') {
                      contemSpam = true;
                      motivoSpam = `conteúdo visual impróprio detectado por Inteligência Artificial no ${tipoMidia}`;
                    } else if (resultadoIA === 'FALHA') {
                      console.warn(`⚠️ [Moderador IA] ${tipoMidia} não analisada (Gemini indisponível após retries).`);
                      io.to(usuarioId).emit('log_seguranca', {
                        data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                        grupo: nomeGrupo,
                        membro: participanteId.split('@')[0],
                        nome: msg._data.notifyName || 'Membro',
                        acao: 'ALLOW',
                        motivo: `${tipoMidia}: IA indisponível (503/timeout) — legenda já foi checada por palavras-chave`
                      });
                    } else {
                      io.to(usuarioId).emit('log_seguranca', {
                        data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                        grupo: nomeGrupo,
                        membro: participanteId.split('@')[0],
                        nome: msg._data.notifyName || 'Membro',
                        acao: 'ALLOW',
                        motivo: `${tipoMidia.charAt(0).toUpperCase() + tipoMidia.slice(1)} de ${tamanhoMB.toFixed(2)}MB analisado e LIBERADO pela IA`
                      });
                    }
                  }
                } else {
                  console.log(`ℹ️ [Moderador IA] Tipo de mídia não analisado por IA: ${media.mimetype}`);
                }
              } else {
                console.log(`⚠️ [Moderador IA] Falha ao baixar mídia de ${participanteId}: downloadMedia retornou vazio.`);
                io.to(usuarioId).emit('log_seguranca', {
                  data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                  grupo: nomeGrupo,
                  membro: participanteId.split('@')[0],
                  nome: msg._data.notifyName || 'Membro',
                  acao: 'ALLOW',
                  motivo: `Mídia ignorada: Falha ao baixar arquivo (WhatsApp retornou vazio)`
                });
              }
            } catch (err) {
              console.error('⚠️ Falha ao baixar ou analisar mídia com IA:', err.message);
              io.to(usuarioId).emit('log_seguranca', {
                data: new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                grupo: nomeGrupo,
                membro: participanteId.split('@')[0],
                nome: msg._data.notifyName || 'Membro',
                acao: 'ALLOW',
                motivo: `Mídia ignorada: Erro no download/análise IA (${err.message})`
              });
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
                  await chat.sendMessage(`⚠️ @${contato.id.user}, conteúdos proibidos (Conforme Regras do Grupo). Advertência (${advCount}/3). A sua mensagem foi apagada.`, { mentions: [contato] });
                } catch (err) {
                  console.error('❌ Erro ao enviar mensagem de advertência:', err.message);
                }
              }, 2000);
            }

            return; // Interrompe para não salvar nas estatísticas gerais
          }
        }
      }

      // Não contabiliza mensagens da conta conectada ao bot (evita poluir estatísticas)
      if (participanteId === client.info.wid._serialized) {
        return;
      }

      const nomeParticipante = msg._data.notifyName || participanteId.split('@')[0];

      await database.registrarMensagem(usuarioId, groupId, nomeGrupo, participanteId, nomeParticipante);

    // Notifica o painel web para atualizar os gráficos em tempo real se o cliente estiver conectado
    io.to(usuarioId).emit('nova_mensagem', { groupId });
  } catch (err) {
    console.error('⚠️ Erro ao registrar atividade no painel:', err.message);
    // Se o navegador do WhatsApp caiu, encerra a sessão para parar o loop de chamadas em frame/target fechado
    if (erroSessaoFechada(err)) {
      try {
        await encerrarSessao(usuarioId, false);
      } catch (e) {
        console.error('⚠️ Falha ao encerrar sessão após queda do navegador:', e.message);
      }
    }
  }
}

// ─── RESTAURAR SESSÕES ATIVAS NO STARTUP ───

async function restaurarSessoesAnteriores() {
  try {
    // Evita volume lotado no Railway por acúmulo de relatórios
    await limparRelatoriosAntigos(8);

    // Podagem do db_saas.json: remove "0 mensagens" antigos e trunca nomes longos
    try {
      const r = await database.podarBanco({
        zeroMsgHoras: parseInt(process.env.DB_PRUNE_ZERO_HOURS || '24', 10),
        maxNome: parseInt(process.env.DB_PRUNE_MAX_NAME || '60', 10)
      });
      console.log(`🧹 Podagem do banco concluída: removidos=${r.removidos}, nomesTruncados=${r.nomesTruncados}`);
    } catch (e) {
      console.warn('⚠️ Falha na podagem do banco:', e.message);
    }

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

// Rota para depuração de console remota segura no SaaS
app.get('/api/debug-logs', (req, res) => {
  res.type('text/plain').send(debugLogs.join('\n'));
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
        if (erroSessaoFechada(e)) {
          try {
            await encerrarSessao(usuarioId, false);
          } catch (err) {
            console.error('⚠️ Falha ao encerrar sessão após erro de sync groups:', err.message);
          }
        }
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
        if (erroSessaoFechada(e)) {
          try {
            await encerrarSessao(usuarioId, false);
          } catch (err) {
            console.error('⚠️ Falha ao encerrar sessão após erro de stats:', err.message);
          }
        }
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

// Ativa/desativa moderação automática por grupo (painel)
app.post('/api/groups/:groupId/moderation', async (req, res) => {
  const { groupId } = req.params;
  const { usuarioId, ativa } = req.body;
  if (!usuarioId || typeof ativa !== 'boolean') {
    return res.status(400).json({ error: 'usuarioId e ativa (boolean) são obrigatórios!' });
  }
  try {
    await database.salvarModeracaoAtiva(usuarioId, groupId, ativa);
    res.json({ success: true, moderacaoAtiva: ativa });
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
  if (!temChavesGemini()) {
    return res.status(400).json({ error: 'Chave API do Gemini não configurada no servidor!' });
  }
  if (!base64Data || !mimeType) {
    return res.status(400).json({ error: 'Dados da imagem e tipo mime são obrigatórios!' });
  }

  try {
    const resultado = await analisarImagemComIA(base64Data, mimeType);
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
  const qtdChavesGemini = getGeminiKeys().length;
  const modelosGemini = getGeminiModels();
  if (qtdChavesGemini > 0) {
    console.log(
      `🤖 Gemini: ${qtdChavesGemini} chave(s), modelos: ${modelosGemini.join(' → ')} (retry + rotação)`
    );
  } else {
    console.warn(`⚠️ Gemini: GEMINI_API_KEY não configurada — moderação por IA de mídia desativada`);
  }
  console.log(`====================================================`);

  await restaurarSessoesAnteriores();
});
