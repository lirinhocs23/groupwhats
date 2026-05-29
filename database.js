process.env.TZ = 'America/Sao_Paulo';
const fs = require('fs-extra');
const path = require('path');
const dayjs = require('dayjs');

const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'db_saas.json');

// Estrutura padrão inicial do banco de dados local
const DEFAULT_DB = {
  usuarios: [
    {
      id: "usr_1",
      username: "admin",
      password: "admin", // Simples para testes locais rápidos
      nome: "Admin Master"
    }
  ],
  sessoes: [],
  atividade: {} // Estrutura: { [usuarioId]: { [groupId]: { nomeGrupo: string, membros: { [membroId]: { totalMensagens: number, ultimaMensagem: string, nome: string } } } } }
};

/**
 * Garante que o arquivo JSON do banco de dados exista e esteja inicializado.
 */
async function inicializarDB() {
  await fs.ensureFile(DB_PATH);
  try {
    const conteudo = await fs.readJson(DB_PATH);
    // Valida se as chaves principais existem, se não, adiciona
    let atualizado = false;
    for (const key of Object.keys(DEFAULT_DB)) {
      if (!conteudo[key]) {
        conteudo[key] = DEFAULT_DB[key];
        atualizado = true;
      }
    }
    if (atualizado) {
      await fs.writeJson(DB_PATH, conteudo, { spaces: 2 });
    }
  } catch (err) {
    // Arquivo vazio ou inválido -> Inicializa do zero
    await fs.writeJson(DB_PATH, DEFAULT_DB, { spaces: 2 });
    console.log('💾 Banco de dados SaaS JSON inicializado com sucesso.');
  }
}

/**
 * Lê todo o conteúdo do banco de dados.
 */
async function lerDB() {
  await inicializarDB();
  return await fs.readJson(DB_PATH);
}

/**
 * Grava os dados no arquivo JSON.
 */
async function gravarDB(dados) {
  await fs.writeJson(DB_PATH, dados, { spaces: 2 });
}

// ─── MÉTODOS DE USUÁRIOS ───

async function buscarUsuario(username, password) {
  const db = await lerDB();
  return db.usuarios.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password) || null;
}

async function cadastrarUsuario(username, password, nome) {
  const db = await lerDB();
  
  if (db.usuarios.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    throw new Error('Este nome de usuário já está cadastrado!');
  }

  const novoUsuario = {
    id: `usr_${Date.now()}`,
    username: username.trim(),
    password: password.trim(),
    nome: nome.trim()
  };

  db.usuarios.push(novoUsuario);
  await gravarDB(db);
  return novoUsuario;
}

// ─── MÉTODOS DE SESSÕES DO WHATSAPP ───

async function salvarSessao(usuarioId, sessionId, status, numero = '') {
  const db = await lerDB();
  let sessao = db.sessoes.find(s => s.usuarioId === usuarioId);

  if (sessao) {
    sessao.status = status;
    sessao.numero = numero || sessao.numero;
    sessao.updatedAt = new Date().toISOString();
  } else {
    db.sessoes.push({
      usuarioId,
      sessionId,
      status,
      numero,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  await gravarDB(db);
}

async function buscarSessao(usuarioId) {
  const db = await lerDB();
  return db.sessoes.find(s => s.usuarioId === usuarioId) || null;
}

// ─── MÉTODOS DE MONITORAMENTO E ATIVIDADE DE GRUPOS ───

/**
 * Registra a atividade de uma mensagem enviada no grupo para gerar gráficos.
 */
async function registrarMensagem(usuarioId, groupId, nomeGrupo, participanteId, nomeParticipante) {
  const db = await lerDB();

  // Garante os caminhos no objeto de atividades
  if (!db.atividade[usuarioId]) {
    db.atividade[usuarioId] = {};
  }
  if (!db.atividade[usuarioId][groupId]) {
    db.atividade[usuarioId][groupId] = {
      nomeGrupo: nomeGrupo,
      membros: {}
    };
  }

  const grupo = db.atividade[usuarioId][groupId];
  grupo.nomeGrupo = nomeGrupo; // Atualiza o nome se tiver mudado

  if (!grupo.membros[participanteId]) {
    grupo.membros[participanteId] = {
      totalMensagens: 0,
      ultimaMensagem: '',
      nome: nomeParticipante || participanteId.split('@')[0],
      firstSeen: new Date().toISOString()
    };
  }

  const membro = grupo.membros[participanteId];
  membro.totalMensagens += 1;
  membro.ultimaMensagem = new Date().toISOString();
  if (!membro.firstSeen) membro.firstSeen = membro.ultimaMensagem;
  
  // Atualiza o nome apenas se o atual for apenas o número de telefone (ainda não resolvido)
  const numeroTelefone = participanteId.split('@')[0];
  const temNomeValido = membro.nome && membro.nome !== numeroTelefone;
  if (!temNomeValido && nomeParticipante && nomeParticipante !== numeroTelefone) {
    membro.nome = nomeParticipante;
  }

  await gravarDB(db);
}

/**
 * Podagem para reduzir tamanho do db_saas.json (Railway free volume).
 * - Remove membros com 0 mensagens após N horas (firstSeen antigo e sem ultimaMensagem)
 * - Trunca nomes muito longos (emojis/decorações) para reduzir JSON
 * - Mantém membros com advertências mesmo se 0 msgs
 */
async function podarBanco({ zeroMsgHoras = 24, maxNome = 60 } = {}) {
  const db = await lerDB();
  const agora = Date.now();
  const limiteZeroMs = Math.max(1, zeroMsgHoras) * 60 * 60 * 1000;

  let removidos = 0;
  let nomesTruncados = 0;

  const atividade = db.atividade || {};
  for (const [usuarioId, grupos] of Object.entries(atividade)) {
    if (!grupos) continue;
    for (const [groupId, grupo] of Object.entries(grupos)) {
      if (!grupo || !grupo.membros) continue;

      const advert = grupo.advertencias || {};
      for (const [membroId, m] of Object.entries(grupo.membros)) {
        if (!m) continue;

        if (typeof m.nome === 'string' && m.nome.length > maxNome) {
          m.nome = m.nome.slice(0, maxNome);
          nomesTruncados++;
        }

        const total = Number(m.totalMensagens || 0);
        const ultima = (m.ultimaMensagem || '').trim();
        const firstSeen = (m.firstSeen || '').trim();

        // Remove apenas "0 mensagens" sem ultimaMensagem (nunca falou) e sem advertências
        if (total === 0 && !ultima && !advert[membroId]) {
          const base = firstSeen ? Date.parse(firstSeen) : NaN;
          if (!Number.isNaN(base) && (agora - base) > limiteZeroMs) {
            delete grupo.membros[membroId];
            removidos++;
          }
        }
      }
    }
  }

  await gravarDB(db);
  return { removidos, nomesTruncados };
}

/**
 * Retorna uma lista de grupos ativos e monitorados de um cliente.
 */
async function obterGrupos(usuarioId) {
  const db = await lerDB();
  const gruposUsuario = db.atividade[usuarioId] || {};
  
  return Object.keys(gruposUsuario).map(groupId => ({
    id: groupId,
    nome: gruposUsuario[groupId].nomeGrupo,
    totalMembros: Object.keys(gruposUsuario[groupId].membros).length
  }));
}

/**
 * Registra um grupo com lista de membros vazia caso ele não exista no BD.
 * Isso garante que todos os grupos do usuário apareçam na sidebar imediatamente ao conectar!
 */
async function registrarGrupoVazio(usuarioId, groupId, nomeGrupo) {
  const db = await lerDB();

  if (!db.atividade[usuarioId]) {
    db.atividade[usuarioId] = {};
  }
  
  if (!db.atividade[usuarioId][groupId]) {
    db.atividade[usuarioId][groupId] = {
      nomeGrupo: nomeGrupo,
      membros: {}
    };
    await gravarDB(db);
  }
}

/**
 * Retorna os dados analíticos estruturados de um grupo para o Painel Web.
 * Suporta o cruzamento com dados em tempo real (participantesDoGrupo) para mapear
 * membros que ainda têm 0 mensagens sem precisar de logs offline.
 */
async function obterEstatisticasGrupo(usuarioId, groupId, diasInativoDefault = 30, limiteSilenciosoDefault = 3, participantesDoGrupo = null, botId = null, mensagensRecentes = null, client = null) {
  const db = await lerDB();
  const grupo = (db.atividade[usuarioId] && db.atividade[usuarioId][groupId]);
  
  const nomeGrupo = grupo ? grupo.nomeGrupo : 'Grupo';
  const membrosSalvos = grupo ? grupo.membros : {};

  // Mapeia chaves @lid para JID @c.us correspondentes no banco de dados offline para compatibilidade histórica
  const membrosSalvosMapped = {};
  for (const [key, val] of Object.entries(membrosSalvos)) {
    let resolvedKey = key;
    if (key.endsWith('@lid') && client) {
      try {
        const contato = await client.getContactById(key);
        if (contato && contato.number) {
          resolvedKey = contato.number + '@c.us';
        }
      } catch (e) {
        // Usa a chave original
      }
    }
    
    if (membrosSalvosMapped[resolvedKey]) {
      membrosSalvosMapped[resolvedKey].totalMensagens += val.totalMensagens;
      if (val.ultimaMensagem > membrosSalvosMapped[resolvedKey].ultimaMensagem) {
        membrosSalvosMapped[resolvedKey].ultimaMensagem = val.ultimaMensagem;
      }
    } else {
      membrosSalvosMapped[resolvedKey] = { ...val };
    }
  }

  const agora = dayjs();
  let ativos = 0;
  let silenciosos = 0;
  let fantasmas = 0;

  // Processa as mensagens recentes buscadas em tempo real do WhatsApp para backfill instantâneo
  const contagemRecente = {};
  const ultimaMensagemRecente = {};
  const nomesRecentes = {};
  const lidCache = {};

  if (mensagensRecentes && mensagensRecentes.length > 0) {
    console.log(`🔍 [DEBUG] Encontradas ${mensagensRecentes.length} mensagens recentes no grupo ${nomeGrupo}`);
    for (const msg of mensagensRecentes) {
      // Ignora mensagens do próprio robô
      if (msg.fromMe) continue;
      
      let author = msg.author || msg.from;
      console.log(`  -> msg.id: ${msg.id.id}, author: ${author}, body: ${msg.body ? msg.body.substring(0, 20) : ''}`);
      if (!author) continue;

      // Se for LID, mapeia para c.us usando o contato nativo da mensagem
      if (author.endsWith('@lid')) {
        if (lidCache[author]) {
          author = lidCache[author];
        } else {
          try {
            const contato = await msg.getContact();
            if (contato) {
              let mapped = author;
              if (contato.id && contato.id._serialized && contato.id._serialized.endsWith('@c.us')) {
                mapped = contato.id._serialized;
              } else if (contato.number) {
                mapped = contato.number + '@c.us';
              }
              lidCache[author] = mapped;
              author = mapped;
            }
          } catch (e) {
            // Usa o ID original se falhar
          }
        }
      }

      if (!contagemRecente[author]) {
        contagemRecente[author] = 0;
      }
      contagemRecente[author]++;

      const msgDateStr = new Date(msg.timestamp * 1000).toISOString();
      if (!ultimaMensagemRecente[author] || msgDateStr > ultimaMensagemRecente[author]) {
        ultimaMensagemRecente[author] = msgDateStr;
      }

      // Tenta obter o nome do contato que enviou a mensagem se estiver disponível na payload
      if (msg._data && msg._data.notifyName) {
        nomesRecentes[author] = msg._data.notifyName;
      }
    }
  }

  // Se tivermos os participantes reais via WhatsApp Web
  let listaIdsMembros = [];
  if (participantesDoGrupo && participantesDoGrupo.length > 0) {
    listaIdsMembros = participantesDoGrupo.map(p => ({
      id: p.id._serialized,
      isAdmin: p.isAdmin || p.isSuperAdmin
    }));
  } else {
    // Caso offline: usa o que já está gravado no arquivo JSON
    listaIdsMembros = Object.keys(membrosSalvosMapped).map(id => ({
      id: id,
      isAdmin: false
    }));
  }

  // Se o bot estiver online e o client estiver disponível, tenta obter o nome real dos contatos que estão apenas com o número
  if (client && grupo && grupo.membros) {
    const contatosParaBuscar = listaIdsMembros.filter(item => {
      const membroId = item.id;
      const m = membrosSalvosMapped[membroId];
      const nomeSalvo = m ? m.nome : '';
      const temNomeValido = nomeSalvo && nomeSalvo !== membroId.split('@')[0];
      const temNomeRecente = nomesRecentes[membroId];
      return !temNomeValido && !temNomeRecente;
    });

    if (contatosParaBuscar.length > 0) {
      console.log(`🔍 [SaaS Name Resolver] Buscando nomes reais para ${contatosParaBuscar.length} contatos no WhatsApp Web...`);
      
      const batchSize = 30;
      let houveAtualizacao = false;
      for (let i = 0; i < contatosParaBuscar.length; i += batchSize) {
        const batch = contatosParaBuscar.slice(i, i + batchSize);
        await Promise.all(batch.map(async (item) => {
          try {
            const contato = await client.getContactById(item.id);
            if (contato) {
              const nomeReal = contato.name || contato.pushname;
              if (nomeReal) {
                nomesRecentes[item.id] = nomeReal;
                
                // Grava de forma persistente no BD local do SaaS
                if (!grupo.membros[item.id]) {
                  grupo.membros[item.id] = {
                    totalMensagens: 0,
                    ultimaMensagem: '',
                    nome: nomeReal,
                    firstSeen: new Date().toISOString()
                  };
                } else {
                  grupo.membros[item.id].nome = nomeReal;
                  if (!grupo.membros[item.id].firstSeen) grupo.membros[item.id].firstSeen = new Date().toISOString();
                }
                
                // Também atualiza o mapa em memória usado logo abaixo
                if (!membrosSalvosMapped[item.id]) {
                  membrosSalvosMapped[item.id] = {
                    totalMensagens: 0,
                    ultimaMensagem: '',
                    nome: nomeReal,
                    firstSeen: grupo.membros[item.id]?.firstSeen || new Date().toISOString()
                  };
                } else {
                  membrosSalvosMapped[item.id].nome = nomeReal;
                  if (!membrosSalvosMapped[item.id].firstSeen) membrosSalvosMapped[item.id].firstSeen = grupo.membros[item.id]?.firstSeen || new Date().toISOString();
                }
                houveAtualizacao = true;
              }
            }
          } catch (e) {
            // Ignora erros individuais
          }
        }));
      }
      
      if (houveAtualizacao) {
        await gravarDB(db);
        console.log(`💾 [SaaS Name Resolver] Nomes de contatos atualizados e salvos no banco de dados.`);
      }
    }
  }

  const membrosList = [];

  for (const item of listaIdsMembros) {
    const membroId = item.id;
    
    // Filtra o robô e administradores do grupo (mesma regra dos comandos /inativos e /fantasmas)
    if (botId && membroId === botId) continue;
    if (item.isAdmin) continue;

    const m = membrosSalvosMapped[membroId] || {
      totalMensagens: 0,
      ultimaMensagem: '',
      nome: item.id.split('@')[0]
    };

    // Mescla dados offline do banco com dados em tempo real das mensagens recentes
    const totalMsg = Math.max(m.totalMensagens, contagemRecente[membroId] || 0);
    const ultimaMsgStr = (ultimaMensagemRecente[membroId] && ultimaMensagemRecente[membroId] > m.ultimaMensagem)
      ? ultimaMensagemRecente[membroId]
      : m.ultimaMensagem;
    
    const nomeExibicao = nomesRecentes[membroId] || m.nome || membroId.split('@')[0];

    const ultimaMsg = ultimaMsgStr ? dayjs(ultimaMsgStr) : null;
    const diasSemFalar = ultimaMsg ? agora.diff(ultimaMsg, 'day') : '∞';
    
    let status = '🔥 Ativo';
    if (totalMsg === 0) {
      status = '👻 Fantasma';
      fantasmas++;
    } else if (ultimaMsg && diasSemFalar >= diasInativoDefault) {
      status = '👻 Inativo';
      fantasmas++;
    } else if (totalMsg <= limiteSilenciosoDefault) {
      status = '🤫 Silencioso';
      silenciosos++;
    } else {
      ativos++;
    }

    membrosList.push({
      id: membroId,
      numero: membroId.replace('@c.us', '').replace('@lid', ''),
      nome: nomeExibicao,
      totalMensagens: totalMsg,
      ultimaMensagem: ultimaMsgStr ? dayjs(ultimaMsgStr).format('DD/MM/YYYY HH:mm') : 'Nunca',
      diasSemFalar: ultimaMsgStr ? diasSemFalar : '∞',
      status,
      advertencias: (grupo && grupo.advertencias && grupo.advertencias[membroId]) || 0
    });
  }

  // Ordena os membros por número de mensagens (para ranking)
  const ranking = [...membrosList]
    .filter(m => m.totalMensagens > 0)
    .sort((a, b) => b.totalMensagens - a.totalMensagens)
    .slice(0, 10); // Top 10 mais ativos

  membrosList.sort((a, b) => {
    const ordemStatus = (s) => {
      if (s.includes('Fantasma')) return 0;
      if (s.includes('Inativo')) return 1;
      if (s.includes('Silencioso')) return 2;
      return 3;
    };
    const ds = ordemStatus(a.status) - ordemStatus(b.status);
    if (ds !== 0) return ds;
    return (a.nome || a.numero).localeCompare(b.nome || b.numero, 'pt-BR');
  });

  let adminsExcluidos = 0;
  let botExcluido = 0;
  if (participantesDoGrupo && participantesDoGrupo.length > 0) {
    for (const p of participantesDoGrupo) {
      const pid = p.id._serialized;
      if (botId && pid === botId) botExcluido = 1;
      else if (p.isAdmin || p.isSuperAdmin) adminsExcluidos++;
    }
  }

  const fantasmasComLimite = filtrarFantasmas(membrosList, limiteSilenciosoDefault);

  return {
    nomeGrupo,
    totais: {
      ativos,
      silenciosos,
      fantasmas,
      total: membrosList.length,
      /** Mesma regra do comando /fantasmas [limite] */
      fantasmasComLimite: fantasmasComLimite.length
    },
    meta: {
      fonte: participantesDoGrupo && participantesDoGrupo.length > 0 ? 'whatsapp' : 'banco_local',
      totalNoGrupoWhatsApp: participantesDoGrupo ? participantesDoGrupo.length : null,
      adminsExcluidos,
      botExcluido,
      membrosExibidos: membrosList.length,
      limiteFantasmas: limiteSilenciosoDefault,
      diasInatividade: diasInativoDefault,
      aviso: participantesDoGrupo && participantesDoGrupo.length > 0
        ? null
        : 'Bot offline ou sem acesso ao grupo: lista pode estar incompleta (só quem já foi registrado no banco).'
    },
    ranking,
    membrosList,
    termosProibidos: (grupo && grupo.termosProibidos) || [],
    linksPermitidos: (grupo && grupo.linksPermitidos) || [],
    moderacaoAtiva: !!(grupo && grupo.moderacaoAtiva)
  };
}

/**
 * Mesma lógica do comando /fantasmas: 0 mensagens ou abaixo do limite informado.
 */
function filtrarFantasmas(membrosList, limite) {
  const n = parseInt(limite, 10);
  const lim = Number.isFinite(n) ? n : 3;
  return (membrosList || []).filter(
    (m) => m.status === '👻 Fantasma' || m.totalMensagens < lim
  );
}

/**
 * Registra e incrementa uma advertência para um membro em db_saas.json
 */
async function registrarAdvertencia(usuarioId, groupId, membroId) {
  const db = await lerDB();
  
  if (!db.atividade[usuarioId]) {
    db.atividade[usuarioId] = {};
  }
  if (!db.atividade[usuarioId][groupId]) {
    db.atividade[usuarioId][groupId] = {
      nomeGrupo: 'Grupo',
      membros: {}
    };
  }
  
  const grupo = db.atividade[usuarioId][groupId];
  if (!grupo.advertencias) {
    grupo.advertencias = {};
  }
  
  if (!grupo.advertencias[membroId]) {
    grupo.advertencias[membroId] = 0;
  }
  
  grupo.advertencias[membroId] += 1;
  const count = grupo.advertencias[membroId];
  await gravarDB(db);
  return count;
}

/**
 * Reseta ou remove as advertências de um membro
 */
async function zerarAdvertencias(usuarioId, groupId, membroId) {
  const db = await lerDB();
  const grupo = db.atividade[usuarioId] && db.atividade[usuarioId][groupId];
  if (grupo && grupo.advertencias && grupo.advertencias[membroId]) {
    delete grupo.advertencias[membroId];
    await gravarDB(db);
  }
}

/**
 * Salva as palavras proibidas customizadas de um grupo.
 */
async function salvarTermosProibidos(usuarioId, groupId, termos) {
  const db = await lerDB();
  if (!db.atividade[usuarioId]) {
    db.atividade[usuarioId] = {};
  }
  if (!db.atividade[usuarioId][groupId]) {
    db.atividade[usuarioId][groupId] = {
      nomeGrupo: 'Grupo',
      membros: {}
    };
  }
  db.atividade[usuarioId][groupId].termosProibidos = termos;
  await gravarDB(db);
}

/**
 * Salva a whitelist de domínios (links permitidos) de um grupo.
 */
async function salvarModeracaoAtiva(usuarioId, groupId, ativa) {
  const db = await lerDB();
  if (!db.atividade[usuarioId]) {
    db.atividade[usuarioId] = {};
  }
  if (!db.atividade[usuarioId][groupId]) {
    db.atividade[usuarioId][groupId] = {
      nomeGrupo: 'Grupo',
      membros: {}
    };
  }
  db.atividade[usuarioId][groupId].moderacaoAtiva = !!ativa;
  await gravarDB(db);
}

async function salvarLinksPermitidos(usuarioId, groupId, links) {
  const db = await lerDB();
  if (!db.atividade[usuarioId]) {
    db.atividade[usuarioId] = {};
  }
  if (!db.atividade[usuarioId][groupId]) {
    db.atividade[usuarioId][groupId] = {
      nomeGrupo: 'Grupo',
      membros: {}
    };
  }
  db.atividade[usuarioId][groupId].linksPermitidos = links;
  await gravarDB(db);
}

async function alterarSenha(usuarioId, senhaAtual, novaSenha) {
  const db = await lerDB();
  const usuario = db.usuarios.find(u => u.id === usuarioId);
  if (!usuario) {
    throw new Error('Usuário não encontrado!');
  }
  if (usuario.password !== senhaAtual) {
    throw new Error('A senha atual está incorreta!');
  }
  usuario.password = novaSenha.trim();
  await gravarDB(db);
  return true;
}

module.exports = {
  inicializarDB,
  lerDB,
  buscarUsuario,
  cadastrarUsuario,
  alterarSenha,
  salvarSessao,
  buscarSessao,
  registrarMensagem,
  registrarGrupoVazio,
  registrarAdvertencia,
  zerarAdvertencias,
  salvarTermosProibidos,
  salvarModeracaoAtiva,
  salvarLinksPermitidos,
  podarBanco,
  filtrarFantasmas,
  obterGrupos,
  obterEstatisticasGrupo
};
