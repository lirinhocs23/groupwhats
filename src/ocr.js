const { createWorker } = require('tesseract.js');
const CryptoJS = require('crypto-js');

/**
 * Extrai texto de uma imagem (buffer) usando Tesseract.js.
 * @param {Buffer} buffer - Dados da imagem.
 * @returns {Promise<string>} Texto reconhecido (trimmed).
 */
async function extrairTexto(buffer) {
  const worker = await createWorker();
  await worker.loadLanguage('por'); // Português – pode ser ajustado
  await worker.initialize('por');
  const { data: { text } } = await worker.recognize(buffer);
  await worker.terminate();
  return text.trim();
}

/**
 * Gera hash MD5 da imagem usando crypto-js.
 * @param {Buffer} buffer - Dados da imagem.
 * @returns {string} Hash hexadecimal.
 */
function gerarHashImagem(buffer) {
  const wordArray = CryptoJS.lib.WordArray.create(buffer);
  return CryptoJS.MD5(wordArray).toString();
}

module.exports = { extrairTexto, gerarHashImagem };
