const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../cache.json');
let memoryCache = {};

// Carrega o cache do disco se existir
if (fs.existsSync(CACHE_FILE)) {
  try {
    memoryCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    console.error('⚠️ [CACHE] Erro ao ler cache.json', e.message);
  }
}

function getCache(hash) {
  return memoryCache[hash];
}

function setCache(hash, result) {
  memoryCache[hash] = result;
  // Gravação em disco fire-and-forget
  fs.writeFile(CACHE_FILE, JSON.stringify(memoryCache), (err) => {
    if (err) console.error('⚠️ [CACHE] Erro ao salvar cache.json', err.message);
  });
}

module.exports = { getCache, setCache };
