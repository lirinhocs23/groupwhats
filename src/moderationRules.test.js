const { avaliarTexto } = require('./moderationRules');

const casos = [
  { msg: 'morreu de rir', esperado: true },
  { msg: 'vou ali comprar pão', esperado: true },
  { msg: 'vendo espada usada', esperado: true, grupoEspada: true },
  { msg: 'rifa de carro chama no pv', esperado: false },
  { msg: 'morreu no acidente na BR', esperado: false },
  { msg: 'vendo som automotivo', esperado: false },
  { msg: 'filho da puta', esperado: false }
];

let falhas = 0;
for (const c of casos) {
  const r = avaliarTexto(c.msg, { grupoEspada: !!c.grupoEspada });
  const ok = r.permitido === c.esperado;
  if (!ok) {
    falhas++;
    console.error('FALHA:', c.msg, '->', r, 'esperado permitido=', c.esperado);
  } else {
    console.log('OK:', c.msg);
  }
}
process.exit(falhas > 0 ? 1 : 0);
