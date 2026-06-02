/**
 * Cliente Gemini compartilhado (texto + visão) — usado por index.js e server.js.
 * Configure: GEMINI_API_KEY, GEMINI_MODEL, GEMINI_MODEL_FALLBACK, GEMINI_RETRY_*
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const { PROMPT_REGRAS_GRUPO } = require('./moderationRules');

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
  if (status === 429 || status === 403) return true;
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
          return resultado.res;
        }

        ultimoStatus = resultado.status;
        ultimoErroJson = resultado.errData;

        if (resultado.status === 400) {
          console.error(`❌ Gemini [${model}] HTTP 400 chave ${label}:`, JSON.stringify(ultimoErroJson));
          return { ok: false, status: resultado.status, errData: ultimoErroJson };
        }

        if (geminiDeveTrocarChave(resultado.status, resultado.errData)) {
          console.warn(`🔑 Gemini [${model}] cota/limite HTTP ${resultado.status} — próxima chave...`);
          break;
        }

        if (GEMINI_RETRY_HTTP.has(resultado.status) && tentativa < GEMINI_MAX_TENTATIVAS) {
          await sleepMs(GEMINI_RETRY_BASE_MS * tentativa);
          continue;
        }

        if (ki < keys.length - 1) break;
        return { ok: false, status: resultado.status, errData: resultado.errData };
      } catch (err) {
        if (tentativa < GEMINI_MAX_TENTATIVAS) {
          await sleepMs(GEMINI_RETRY_BASE_MS * tentativa);
          continue;
        }
        if (ki < keys.length - 1) break;
        throw err;
      }
    }
  }

  currentGeminiKeyIndex = (currentGeminiKeyIndex + 1) % keys.length;
  return { ok: false, status: ultimoStatus, errData: ultimoErroJson };
}

async function chamarGeminiComRotacaoChaves(payload, timeoutMs = 25000) {
  const models = getGeminiModels();
  let ultimoErro = { ok: false, status: 0, errData: null };

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const resultado = await chamarGeminiComRotacaoChavesComModelo(payload, timeoutMs, model);

    if (resultado && resultado.ok !== false && typeof resultado.json === 'function') {
      if (mi > 0) console.log(`✅ Gemini respondeu com modelo reserva: ${model}`);
      return resultado;
    }

    ultimoErro = resultado;
    const retryable = [429, 500, 503, 504].includes(resultado.status);
    if (mi < models.length - 1 && retryable) {
      console.warn(`⚠️ Modelo ${model} indisponível (HTTP ${resultado.status}). Tentando ${models[mi + 1]}...`);
    }
  }

  return ultimoErro;
}

async function analisarImagemComIA(base64Data, mimeType) {
  try {
    const parts = [
      {
        text:
          'Você é um moderador extremamente rigoroso de grupo de WhatsApp.\n' +
          'Analise os frames do vídeo ou a imagem enviada. Você DEVE decidir se a imagem viola as regras do grupo.\n\n' +
          'Regras Proibidas (responda true se houver alguma delas):\n' +
          '1. ACIDENTES OU CARROS BATIDOS.\n' +
          '2. JOGOS DE AZAR / APOSTAS.\n' +
          '3. PROPAGANDAS, SERVIÇOS E VENDAS (rifas, IPTV, panfletos comerciais).\n\n' +
          'Permitido: cultura de espadas juninas, fogos artesanais, fotos normais do dia a dia.\n\n' +
          'Responda estritamente JSON: {"raciocinio":"...","proibido":true|false}'
      }
    ];

    if (mimeType.startsWith('video/')) {
      const buffer = Buffer.from(base64Data, 'base64');
      const tmpDir = os.tmpdir();
      const id = crypto.randomUUID();
      const videoPath = path.join(tmpDir, `${id}.mp4`);

      try {
        fs.writeFileSync(videoPath, buffer);
        await new Promise((resolve, reject) => {
          ffmpeg(videoPath)
            .screenshots({
              timestamps: ['25%', '50%', '75%'],
              filename: `${id}_%i.jpg`,
              folder: tmpDir
            })
            .on('end', resolve)
            .on('error', reject);
        });
        for (let i = 1; i <= 3; i++) {
          const framePath = path.join(tmpDir, `${id}_${i}.jpg`);
          if (fs.existsSync(framePath)) {
            const frameBuffer = fs.readFileSync(framePath);
            parts.push({
              inlineData: { mimeType: 'image/jpeg', data: frameBuffer.toString('base64') }
            });
            fs.unlinkSync(framePath);
          }
        }
      } finally {
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        fs
          .readdirSync(tmpDir)
          .filter((f) => f.startsWith(`${id}_`) && (f.endsWith('.jpg') || f.endsWith('.png')))
          .forEach((f) => {
            try {
              fs.unlinkSync(path.join(tmpDir, f));
            } catch {
              /* ignore */
            }
          });
      }
    } else {
      parts.push({ inlineData: { mimeType, data: base64Data } });
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: { responseMimeType: 'application/json' },
      safetySettings: [
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
      ]
    };

    const res = await chamarGeminiComRotacaoChaves(payload, 25000);
    if (!res.ok) return 'FALHA';

    const data = await res.json();
    if (data.promptFeedback?.blockReason) return 'SIM';
    if (data.candidates?.[0]?.finishReason === 'SAFETY') return 'SIM';

    const textoOriginal = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    try {
      const parsed = JSON.parse(textoOriginal.trim());
      return parsed.proibido ? 'SIM' : 'NAO';
    } catch {
      const textoUpper = textoOriginal.toUpperCase();
      if (/\bSIM\b/.test(textoUpper) || /\bTRUE\b/.test(textoUpper)) return 'SIM';
      return 'NAO';
    }
  } catch (err) {
    console.error('⚠️ Erro na análise de visão do Gemini:', err.message);
    return 'FALHA';
  }
}

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
    if (!res.ok) return 'FALHA';

    const data = await res.json();
    const textoResposta = data.candidates?.[0]?.content?.parts?.[0]?.text?.toUpperCase() || 'NAO';
    return textoResposta.includes('SIM') ? 'SIM' : 'NAO';
  } catch (err) {
    console.error('⚠️ Erro na análise de texto do Gemini:', err.message);
    return 'FALHA';
  }
}

module.exports = {
  temChavesGemini,
  getGeminiKeys,
  getGeminiModels,
  analisarTextoComIA,
  analisarImagemComIA
};
