const INTERVAL_MS = 5000;
let lastCallTime = 0;
let queuePromise = Promise.resolve();

/**
 * Aguarda o tempo necessário para respeitar o rate limit.
 * Garante que chamadas simultâneas fiquem na fila sequencialmente.
 */
async function waitRateLimit() {
  const execute = async () => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCallTime;
    if (timeSinceLastCall < INTERVAL_MS) {
      const delay = INTERVAL_MS - timeSinceLastCall;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    lastCallTime = Date.now();
  };

  queuePromise = queuePromise.then(execute).catch(execute);
  return queuePromise;
}

module.exports = { waitRateLimit };
