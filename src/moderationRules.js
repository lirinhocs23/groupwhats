/**
 * Regras de moderação alinhadas a regras.md — libera gírias/cotidiano antes de punir.
 */

const FRASES_PERMITIDAS = [
  'morreu de rir',
  'morri de rir',
  'morrendo de rir',
  'morro de rir',
  'comprar pao',
  'comprar paes',
  'vou comprar',
  'vou ali comprar',
  'ir comprar',
  'fui comprar',
  'indo comprar',
  'preciso comprar',
  'vou la comprar'
];

const TERMOS_OFENSIVOS = [
  'filho da puta',
  'filha da puta',
  'arrombado',
  'arrombada',
  'desgraca',
  'desgracado',
  'fdp',
  'vsf',
  'vai se foder',
  'vai tomar no cu',
  'tomanocu',
  'puta que pariu',
  'pqp',
  'vagabundo',
  'vagabunda',
  'corno',
  'corna',
  'rapariga',
  'macaco'
];

/** Apostas, golpes, correntes — palavra ou frase com limite de palavra */
const TERMOS_ABSOLUTOS = [
  'aposta',
  'bets',
  'betano',
  'blaze',
  'cassino',
  'casino',
  'roleta',
  'slots',
  'tigrinho',
  'fortune tiger',
  'fortune ox',
  'fortune rabbit',
  'sorte online',
  'link de aposta',
  'aposta ganhadora',
  'previsao de jogo',
  'esporte bets',
  'plataforma pagando',
  'ganhos suspeitos',
  'renda extra',
  'ganhe dinheiro',
  'ganho garantido',
  'investimento garantido',
  'robo do pix',
  'oportunidade unica',
  'renda facil',
  'dinheiro rapido',
  'repasse para',
  'compartilhe com',
  'se voce nao enviar',
  'mensagem de sorte',
  'corrente',
  'assassinato',
  'homicidio',
  'necroterio'
];

/** Tragédia/violência real — só frases (evita "morreu de rir") */
const FRASES_TRAGEDIA = [
  'grave acidente',
  'morreu no acidente',
  'morreu no acidente',
  'morreu em acidente',
  'faleceu no acidente',
  'foi baleado',
  'foi baleada',
  'capotou',
  'capotamento',
  'acidente de transito',
  'acidente na br',
  'acidente fatal',
  'atropelamento',
  'corpo sem vida',
  'cena de crime',
  'sangue no asfalto',
  'vitima fatal',
  'obito confirmado'
];

/** Spam comercial/rifa — sem compra/comprar genéricos */
const TERMOS_SPAM_COMERCIAL = [
  'rifa',
  'rifas',
  'rifeiro',
  'sorteio',
  'sorteios',
  'cota',
  'cotas',
  'acao entre amigos',
  'bilhete',
  'bilhetes',
  'chama no pv',
  'chama pv',
  'chama no zap',
  'chamar no pv',
  'valor no pv',
  'interessados chamar',
  'oportunidade de emprego',
  'trabalhe em casa',
  'venda de carro',
  'venda de moto',
  'geladeira usada',
  'som automotivo',
  'ze da barata',
  'zé da barata',
  'ligue e contrate',
  'promocao de hoje',
  'compre agora',
  'adquira seu bilhete',
  'adquira ja'
];

/** Serviços/comércio fora do tema espadas (grupos de espada) */
const TERMOS_SERVICO = [
  'estofado',
  'estofados',
  'higienizacao',
  'impermeabilizacao',
  'dedetizacao',
  'desentupidora',
  'encanador',
  'eletricista',
  'pintor',
  'pedreiro',
  'gesseiro',
  'marceneiro',
  'autolavagem',
  'martelinho',
  'funilaria',
  'mecanica',
  'oficina mecanica',
  'clinica',
  'estetica',
  'depilacao',
  'manicure',
  'delivery',
  'pizzaria',
  'hamburgueria',
  'acai',
  'sorveteria',
  'pet shop',
  'veterinario',
  'advogado',
  'contador',
  'personal trainer',
  'nutricionista',
  'psicologo',
  'fisioterapia',
  'massagem',
  'colchoes',
  'moveis',
  'moveis planejados'
];

const FRASES_SERVICO_COMERCIAL = [
  'lavagem a seco',
  'lavagem ar seco',
  'lavagem em domicilio',
  'higienizacao de',
  'higienizacao em',
  'agendar seu horario',
  'agende seu horario',
  'trabalhamos em domicilio',
  'orcamento pelo zap',
  'orcamento no zap',
  'orcamento via zap',
  'chame no whats',
  'chama no whats',
  'servico de limpeza',
  'limpeza de sofa',
  'limpeza de sofas',
  'antes e depois',
  'pix e cartao',
  'aceitamos cartao',
  'parcelamos em',
  'promocao imperdivel',
  'melhor preco da cidade'
];

const TERMOS_UNIVERSO_ESPADA = [
  'espada',
  'espadas',
  'polvora',
  'barro',
  'bambivis',
  'prensa',
  'bambu',
  'fogueira',
  'corda',
  'cordas',
  'pilao',
  'cilindro',
  'fogo',
  'junina',
  'sao joao'
];

const PRODUTOS_GENERICOS = [
  'carro',
  'moto',
  'celular',
  'geladeira',
  'som automotivo',
  'alto falante',
  'pneu',
  'pneus',
  'iptv',
  'netflix',
  'apartamento',
  'imovel'
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizarTextoParaFiltro(texto) {
  if (!texto) return '';

  let textoNormalizado = texto.toLowerCase();
  textoNormalizado = textoNormalizado.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const leetMap = {
    '@': 'a',
    '4': 'a',
    '1': 'i',
    '!': 'i',
    '|': 'i',
    '0': 'o',
    '3': 'e',
    '5': 's',
    '$': 's'
  };

  for (const [leet, normal] of Object.entries(leetMap)) {
    textoNormalizado = textoNormalizado.replaceAll(leet, normal);
  }

  textoNormalizado = textoNormalizado.replace(/[^a-z0-9\s]/g, '');
  textoNormalizado = textoNormalizado.replace(/\s+/g, ' ').trim();

  return textoNormalizado;
}

function contemTermo(textoNorm, termo) {
  const t = normalizarTextoParaFiltro(termo);
  if (!t) return false;
  if (/\s/.test(t)) {
    return textoNorm.includes(t);
  }
  return new RegExp(`\\b${escapeRegex(t)}\\b`, 'i').test(textoNorm);
}

function mensagemTemFrasePermitida(textoNorm) {
  return FRASES_PERMITIDAS.some((frase) => textoNorm.includes(frase));
}

function temTermoUniversoEspada(textoNorm) {
  return TERMOS_UNIVERSO_ESPADA.some((t) => contemTermo(textoNorm, t));
}

/** Telefone ou @ de rede social na mensagem original (antes de normalizar) */
function detectarContatoComercial(corpoBruto) {
  if (!corpoBruto || typeof corpoBruto !== 'string') return false;
  const tel = /(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-.\s]?\d{4}\b/;
  const ig = /@[\w.]{3,30}/;
  return tel.test(corpoBruto) || ig.test(corpoBruto);
}

function detectarAnuncioServico(textoNorm) {
  for (const frase of FRASES_SERVICO_COMERCIAL) {
    if (textoNorm.includes(frase)) return frase;
  }
  for (const termo of TERMOS_SERVICO) {
    if (contemTermo(textoNorm, termo)) return termo;
  }
  return null;
}

/**
 * @param {string} corpo - texto bruto da mensagem
 * @param {{ termosCustomizados?: string[], grupoEspada?: boolean }} opts
 * @returns {{ permitido: boolean, motivo?: string, camada?: string, bloqueiaIA?: boolean }}
 */
function avaliarTexto(corpo, opts = {}) {
  const texto = normalizarTextoParaFiltro(corpo);
  if (!texto) {
    return { permitido: true, camada: 'vazio' };
  }

  if (mensagemTemFrasePermitida(texto)) {
    return { permitido: true, camada: 'frase', motivo: 'expressão cotidiana ou gíria permitida' };
  }

  const termosCustomizados = opts.termosCustomizados || [];
  if (termosCustomizados.length > 0) {
    for (const termo of termosCustomizados) {
      const tn = normalizarTextoParaFiltro(termo);
      if (tn && new RegExp(`\\b${escapeRegex(tn)}\\b`, 'i').test(texto)) {
        return {
          permitido: false,
          camada: 'custom',
          motivo: `termo proibido personalizado ("${termo}")`,
          /** Termos do painel = regra do admin; não revalidar com Gemini (evita liberar Heineken, cerveja, etc.) */
          bloqueiaIA: true
        };
      }
    }
  }

  for (const ofensa of TERMOS_OFENSIVOS) {
    if (contemTermo(texto, ofensa)) {
      return {
        permitido: false,
        camada: 'ofensa',
        motivo: `ofensa grave ("${ofensa}")`,
        bloqueiaIA: true
      };
    }
  }

  for (const termo of TERMOS_ABSOLUTOS) {
    if (contemTermo(texto, termo)) {
      return {
        permitido: false,
        camada: 'absoluto',
        motivo: `conteúdo proibido ("${termo}")`,
        bloqueiaIA: false
      };
    }
  }

  for (const frase of FRASES_TRAGEDIA) {
    if (texto.includes(frase)) {
      return {
        permitido: false,
        camada: 'absoluto',
        motivo: `tragédia/violência fora de contexto ("${frase}")`,
        bloqueiaIA: false
      };
    }
  }

  if (termosCustomizados.length === 0) {
    for (const termo of TERMOS_SPAM_COMERCIAL) {
      if (contemTermo(texto, termo)) {
        return {
          permitido: false,
          camada: 'comercial',
          motivo: `spam ou divulgação ("${termo}")`,
          bloqueiaIA: false
        };
      }
    }

    const temVendo = contemTermo(texto, 'vendo') || contemTermo(texto, 'vende se');
    if (temVendo) {
      const temProdutoGenerico = PRODUTOS_GENERICOS.some((p) => contemTermo(texto, p));
      const temEspada = temTermoUniversoEspada(texto);

      if (temProdutoGenerico && !temEspada) {
        return {
          permitido: false,
          camada: 'comercial',
          motivo: 'anúncio de produto fora do tema espadas/acessórios',
          bloqueiaIA: false
        };
      }

      if (opts.grupoEspada || temEspada) {
        return { permitido: true, camada: 'frase', motivo: 'compra/venda de espadas permitida (regra 5)' };
      }
    }

    // Anúncios de serviço fora do tema (ex.: higienização de estofados)
    if (opts.grupoEspada) {
      const servico = detectarAnuncioServico(texto);
      if (servico) {
        return {
          permitido: false,
          camada: 'servico',
          motivo: `anúncio de serviço fora do tema ("${servico}")`,
          bloqueiaIA: true
        };
      }

      if (detectarContatoComercial(corpo) && texto.length >= 25) {
        const temSinalServico =
          FRASES_SERVICO_COMERCIAL.some((f) => texto.includes(f)) ||
          TERMOS_SERVICO.some((t) => contemTermo(texto, t)) ||
          TERMOS_SPAM_COMERCIAL.some((t) => contemTermo(texto, t));
        if (temSinalServico) {
          return {
            permitido: false,
            camada: 'servico',
            motivo: 'divulgação comercial (contato + serviço/propaganda)',
            bloqueiaIA: true
          };
        }
      }
    }
  }

  return { permitido: true, camada: 'ok' };
}

/** Prompt base para IA de contexto (regras.md) */
const PROMPT_REGRAS_GRUPO = `Regras do grupo (regras.md):
1. Respeito acima de tudo — sem ofensas ou preconceito.
2. Foco em espadas: vídeos, fotos e assuntos de espadas são bem-vindos.
3. Proibido imagens/vídeos fortes de acidentes, sangue ou mortes FORA de contexto do grupo.
4. Proibido spam: jogos de aposta, política, pornografia, golpes, rifas, assuntos sem relação.
5. Compra e venda de espadas e acessórios é LIBERADA.
6. Evite flood e correntes.
7. Debates permitidos sem perseguição.

Sempre PERMITIR: gírias como "morreu de rir", conversas do dia a dia como "vou comprar pão", anúncios de espadas/acessórios.
Bloquear SIM apenas: spam comercial claro, apostas, rifas, violência/acidente real, ofensas graves.`;

/** Controle global de duplicata message vs message_create (evita 2º evento com corpo ser descartado) */
const mensagensVistas = new Map();

/**
 * ID do remetente em grupo. Com fromMe, author vem vazio e from é o JID do grupo.
 */
function resolverParticipanteId(msg, client) {
  if (msg.fromMe && client?.info?.wid?._serialized) {
    return client.info.wid._serialized;
  }
  return msg.author || msg.from;
}

/**
 * ID correto para enviar DM (PV) a quem disparou o comando no grupo.
 */
function obterIdPrivadoRemetente(msg, participanteId, client) {
  if (msg.fromMe && client?.info?.wid?._serialized) {
    return client.info.wid._serialized;
  }
  if (participanteId && !participanteId.endsWith('@g.us')) {
    return participanteId;
  }
  if (msg.author && !String(msg.author).endsWith('@g.us')) {
    return msg.author;
  }
  return client?.info?.wid?._serialized || participanteId;
}

/**
 * Primeiro evento (message) às vezes chega sem body; message_create traz o texto.
 * Retorna true se deve processar agora.
 */
function deveProcessarMensagemAgora(msg) {
  const key = msg.id?._serialized || msg.id?.id;
  if (!key) return false;

  const temConteudo = !!(msg.body || '').trim() || msg.hasMedia;
  const estado = mensagensVistas.get(key);

  if (estado === 'done') return false;

  if (!temConteudo) {
    if (!estado) mensagensVistas.set(key, 'pending');
    return false;
  }

  mensagensVistas.set(key, 'done');
  if (mensagensVistas.size > 2000) {
    const manter = [...mensagensVistas.keys()].slice(-1000);
    mensagensVistas.clear();
    manter.forEach((k) => mensagensVistas.set(k, 'done'));
  }
  return true;
}

/**
 * Em mensagens enviadas por você (fromMe), msg.from é seu @c.us e msg.to é o grupo @g.us.
 * Em mensagens de outros, msg.from é o grupo.
 */
function resolverIdGrupo(msg) {
  const from = msg.from ? String(msg.from) : '';
  const to = msg.to ? String(msg.to) : '';
  if (from.endsWith('@g.us')) return from;
  if (msg.fromMe && to.endsWith('@g.us')) return to;
  return null;
}

function ehMensagemDeGrupo(msg) {
  return !!resolverIdGrupo(msg);
}

/** Figurinha do WhatsApp (não gastar cota do Gemini). */
function ehFigurinhaWhatsApp(msg) {
  if (!msg) return false;
  const tipo = String(msg.type || msg._data?.type || '').toLowerCase();
  if (tipo === 'sticker') return true;
  if (msg._data?.stickerSentTs != null) return true;
  return false;
}

/**
 * Só imagem ou vídeo reais vão para análise por IA.
 * Ignora figurinha, áudio, documento, GIF como sticker, etc.
 */
function deveAnalisarMidiaComIA(msg) {
  if (!msg?.hasMedia) return false;
  if (ehFigurinhaWhatsApp(msg)) return false;

  const tipo = String(msg.type || msg._data?.type || '').toLowerCase();
  return tipo === 'image' || tipo === 'video';
}

/** Após download: reforço se mimetype for de figurinha */
function mimetypeEhFigurinha(mimetype, msg) {
  if (ehFigurinhaWhatsApp(msg)) return true;
  const mt = (mimetype || '').toLowerCase();
  if (mt === 'image/webp' && ehFigurinhaWhatsApp(msg)) return true;
  return false;
}

/** Normaliza comando: "/ajuda " -> { cmd: '/ajuda', texto: '...' } */
function parseComando(corpo) {
  const texto = (corpo || '').trim();
  if (!texto.startsWith('/')) return { cmd: '', texto: '' };
  const partes = texto.split(/\s+/);
  return { cmd: partes[0].toLowerCase(), texto, partes };
}

module.exports = {
  FRASES_PERMITIDAS,
  normalizarTextoParaFiltro,
  avaliarTexto,
  detectarAnuncioServico,
  detectarContatoComercial,
  PROMPT_REGRAS_GRUPO,
  resolverParticipanteId,
  resolverIdGrupo,
  ehMensagemDeGrupo,
  ehFigurinhaWhatsApp,
  deveAnalisarMidiaComIA,
  mimetypeEhFigurinha,
  obterIdPrivadoRemetente,
  deveProcessarMensagemAgora,
  parseComando
};
