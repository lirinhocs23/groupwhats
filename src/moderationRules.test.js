const { avaliarTexto, resolverIdGrupo, ehMensagemDeGrupo } = require('./moderationRules');

const grupoId = '120363123456789012@g.us';
const donoId = '557398266511@c.us';

if (resolverIdGrupo({ from: grupoId, to: donoId, fromMe: false }) !== grupoId) {
  console.error('FALHA: grupo em msg.from (recebida)');
  process.exit(1);
}
if (resolverIdGrupo({ from: donoId, to: grupoId, fromMe: true }) !== grupoId) {
  console.error('FALHA: grupo em msg.to quando fromMe (comando do dono 66511)');
  process.exit(1);
}
if (!ehMensagemDeGrupo({ from: donoId, to: grupoId, fromMe: true })) {
  console.error('FALHA: ehMensagemDeGrupo com fromMe');
  process.exit(1);
}
console.log('OK: resolverIdGrupo / fromMe dono sessão');

const casos = [
  { msg: 'morreu de rir', esperado: true },
  { msg: 'vou ali comprar pão', esperado: true },
  { msg: 'vendo espada usada', esperado: true, grupoEspada: true },
  { msg: 'rifa de carro chama no pv', esperado: false },
  { msg: 'morreu no acidente na BR', esperado: false },
  { msg: 'vendo som automotivo', esperado: false },
  { msg: 'filho da puta', esperado: false },
  {
    msg: 'Vamos agendar seu horário Higienização lavagem ar seco estofados sofá',
    esperado: false,
    grupoEspada: true
  },
  {
    msg: 'Higienização de estofados trabalhamos em domicílio',
    esperado: false,
    grupoEspada: true
  }
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
