const palavrasProibidas = [
  'promoção',
  'venda',
  'pix',
  'carro',
  'pneu',
  'som automotivo',
  'alto falante',
  'módulo',
  'taramps',
  'stetsom',
  'loja',
  'compre agora',
  'whatsapp'
];

/**
 * Verifica se o texto contém alguma palavra proibida.
 * @param {string} texto
 * @returns {boolean}
 */
function contemProibido(texto) {
  const lower = texto.toLowerCase();
  return palavrasProibidas.some(p => lower.includes(p));
}

module.exports = { palavrasProibidas, contemProibido };
