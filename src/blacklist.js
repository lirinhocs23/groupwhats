const palavrasProibidas = [
  'promoção',
  'venda',
  'pix',
  'carro',
  'pneu',
  'pneus',
  'roda',
  'rodas',
  'aro',
  'bateria',
  'baterias',
  'amperes',
  'escapamento',
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
 * Verifica se o texto contém alguma palavra proibida (usando limites de palavras para evitar falsos positivos).
 * @param {string} texto
 * @returns {boolean}
 */
function contemProibido(texto) {
  const lower = texto.toLowerCase();
  return palavrasProibidas.some(p => {
    // Escapa a palavra para Regex
    const regex = new RegExp(`\\b${p}\\b`, 'i');
    return regex.test(lower);
  });
}

module.exports = { palavrasProibidas, contemProibido };
