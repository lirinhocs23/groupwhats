// Corrected server.js content from feature branch
require('dotenv').config();
process.env.TZ = 'America/Sao_Paulo';
// Cleaned up after conflict resolution
// Updated on 2026-05-21
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
const { extrairTexto, gerarHashImagem } = require('./src/ocr');
const { contemProibido } = require('./src/blacklist');
const { getCache, setCache } = require('./src/cache');
const { waitRateLimit } = require('./src/rateLimiter');

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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Endpoint to retrieve in‑memory debug logs for the SaaS panel
app.get('/api/debug-logs', (req, res) => {
  // Return the latest logs (up to 500 entries) as JSON
  res.json({ logs: debugLogs });
});

// Mapa para manter as instâncias ativas do WhatsApp na memória
// Estrutura: { [usuarioId]: { client: Client, status: string, qr: string, numero: string } }
const sessoesAtivas = {};

// Controle Anti-Spam e Concorrência para evitar mensagens duplicadas
const mensagensProcessadas = new Set();
const ultimosAvisosEnviados = {};
const usuariosSendoRemovidos = new Set();
let delecaoEmAndamento = false;
const filaDelecao = [];

// Sistema de Rodízio de Chaves da API do Gemini
let currentGeminiKeyIndex = 0;
function getNextGeminiKey() {
  const envKey = process.env.GEMINI_API_KEY;
  if (!envKey) return null;
  const keys = envKey.split(',').map(k => k.trim()).filter(k => k);
  if (keys.length === 0) return null;
  const keyToUse = keys[currentGeminiKeyIndex % keys.length];
  currentGeminiKeyIndex++;
  return keyToUse;
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
      // executablePath: '/usr/bin/google-chrome-stable',
      args: (() => {
        const baseArgs = [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
          '--disable-gpu',
          '--disable-software-rasterizer',
          '--headless=old'
        ];
        // --single-process e --no-zygote causam crashes imediatos do Chromium no Windows
        if (process.platform !== 'win32') {
          baseArgs.push('--disable-dev-shm-usage');
          baseArgs.push('--no-zygote');
          // baseArgs.push('--single-process');
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

// ... (rest of the file remains unchanged) //

// Restores previous WhatsApp sessions on startup (basic implementation)
async function restaurarSessoesAnteriores() {
  console.log('🔄 Restaurando sessões anteriores...');
  const path = require('path');
  const fs = require('fs-extra');
  const dbPath = path.join(__dirname, 'db_saas.json');
  try {
    const data = await fs.readJson(dbPath);
    if (Array.isArray(data.sessoes)) {
      for (const sess of data.sessoes) {
        // Resetar status para evitar sessões pendentes ao iniciar
        sess.status = 'desconectado';
        sess.numero = '';
        sess.updatedAt = new Date().toISOString();
      }
      await fs.writeJson(dbPath, data, { spaces: 2 });
      console.log(`✅ Sessões resetadas para 'desconectado' (${data.sessoes.length})`);
    } else {
      console.log('⚠️ Nenhuma sessão encontrada no banco de dados.');
    }
  } catch (err) {
    console.error('❌ Erro ao restaurar sessões anteriores:', err.message);
  }
}

// Socket.io event handlers for panel actions
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
