/* ==========================================================================
   📌 SCRIPT DE CONTROLE JAVASCRIPT - PAINEL WEB SAAS (WHATSAPP ENGAGEMENT)
   ========================================================================== */

// ─── ESTADO GLOBAL DA APLICAÇÃO ───
let currentUser = null;
let selectedGroupId = null;
let socket = null;
let waStatus = 'desconectado'; // 'desconectado' | 'inicializando' | 'qr' | 'conectado'
let qrcodeInstance = null;

// Instâncias dos Gráficos ApexCharts
let chartPie = null;
let chartBar = null;

// Dados em cache
let membrosGrupoCache = [];

// Elementos DOM
const dom = {
  // Login
  loginContainer: document.getElementById('login-container'),
  loginForm: document.getElementById('login-form'),
  usernameInput: document.getElementById('username'),
  passwordInput: document.getElementById('password'),
  loginError: document.getElementById('login-error'),
  errorText: document.getElementById('error-text'),

  // Cadastro (Register)
  registerContainer: document.getElementById('register-container'),
  registerForm: document.getElementById('register-form'),
  registerNameInput: document.getElementById('register-name'),
  registerUsernameInput: document.getElementById('register-username'),
  registerPasswordInput: document.getElementById('register-password'),
  registerConfirmPasswordInput: document.getElementById('register-confirm-password'),
  registerError: document.getElementById('register-error'),
  registerErrorText: document.getElementById('register-error-text'),
  registerSuccess: document.getElementById('register-success'),
  linkShowRegister: document.getElementById('link-show-register'),
  linkShowLogin: document.getElementById('link-show-login'),
  
  // Dashboard Geral
  dashboardContainer: document.getElementById('dashboard-container'),
  userNameDisplay: document.getElementById('user-name-display'),
  welcomeMessage: document.getElementById('welcome-message'),
  btnLogout: document.getElementById('btn-logout'),
  btnSync: document.getElementById('btn-sync'),
  
  // Sidebar & Responsividade
  sidebarMenu: document.getElementById('sidebar-menu'),
  btnToggleSidebar: document.getElementById('btn-toggle-sidebar'),
  sidebarStatusBadge: document.getElementById('sidebar-status-badge'),
  gruposLista: document.getElementById('grupos-lista'),
  
  // WhatsApp Conexão
  waConnectionPanel: document.getElementById('wa-connection-panel'),
  btnConnectWa: document.getElementById('btn-connect-wa'),
  btnDisconnectWa: document.getElementById('btn-disconnect-wa'),
  qrBox: document.getElementById('qr-box'),
  qrPlaceholder: document.getElementById('qr-placeholder'),
  qrcodeCanvas: document.getElementById('qrcode'),
  qrStatusText: document.getElementById('qr-status-text'),
  
  // Detalhes do Grupo
  groupDetailsSection: document.getElementById('group-details-section'),
  emptyStateSection: document.getElementById('empty-state-section'),
  currentGroupName: document.getElementById('current-group-name'),
  filterDias: document.getElementById('filter-dias'),
  filterLimite: document.getElementById('filter-limite'),
  
  // Counters
  statTotalMembros: document.getElementById('stat-total-membros'),
  statAtivos: document.getElementById('stat-ativos'),
  statSilenciosos: document.getElementById('stat-silenciosos'),
  statFantasmas: document.getElementById('stat-fantasmas'),
  
  // Moderação
  membroSearch: document.getElementById('membro-search'),
  membrosTableBody: document.getElementById('membros-table-body'),

  // Configurações (Alterar Senha)
  btnSettings: document.getElementById('btn-settings'),
  settingsModal: document.getElementById('settings-modal'),
  btnCloseModal: document.getElementById('btn-close-modal'),
  changePasswordForm: document.getElementById('change-password-form'),
  currentPasswordInput: document.getElementById('current-password'),
  newPasswordInput: document.getElementById('new-password'),
  confirmNewPasswordInput: document.getElementById('confirm-new-password'),
  passwordAlert: document.getElementById('password-alert')
};

// ─── 🔑 EVENTO: LOGIN ───
dom.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = dom.usernameInput.value.trim();
  const password = dom.passwordInput.value.trim();
  
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Erro ao realizar login!');
    }
    
    // Sucesso no login
    currentUser = data;
    localStorage.setItem('saas_user', JSON.stringify(currentUser));
    
    iniciarDashboard();
  } catch (err) {
    dom.loginError.classList.remove('hidden');
    dom.errorText.textContent = err.message;
  }
});

// ─── 🔄 EVENTOS DE ALTERNÂNCIA: LOGIN / CADASTRO ───
dom.linkShowRegister.addEventListener('click', (e) => {
  e.preventDefault();
  dom.loginError.classList.add('hidden');
  dom.loginContainer.classList.add('hidden');
  dom.registerContainer.classList.remove('hidden');
  dom.registerForm.reset();
  dom.registerError.classList.add('hidden');
  dom.registerSuccess.classList.add('hidden');
});

dom.linkShowLogin.addEventListener('click', (e) => {
  e.preventDefault();
  dom.registerError.classList.add('hidden');
  dom.registerContainer.classList.add('hidden');
  dom.loginContainer.classList.remove('hidden');
  dom.loginForm.reset();
  dom.loginError.classList.add('hidden');
});

// ─── 📝 EVENTO: CADASTRO DE NOVO USUÁRIO ───
dom.registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const nome = dom.registerNameInput.value.trim();
  const username = dom.registerUsernameInput.value.trim();
  const password = dom.registerPasswordInput.value.trim();
  const confirmPassword = dom.registerConfirmPasswordInput.value.trim();
  
  dom.registerError.classList.add('hidden');
  dom.registerSuccess.classList.add('hidden');
  
  if (password !== confirmPassword) {
    dom.registerError.classList.remove('hidden');
    dom.registerErrorText.textContent = 'As senhas digitadas não coincidem!';
    return;
  }
  
  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, nome })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Erro ao criar conta!');
    }
    
    // Sucesso no cadastro
    dom.registerSuccess.classList.remove('hidden');
    
    // Efetua login automático após 2 segundos
    setTimeout(async () => {
      try {
        const loginRes = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const loginData = await loginRes.json();
        if (loginRes.ok) {
          currentUser = loginData;
          localStorage.setItem('saas_user', JSON.stringify(currentUser));
          iniciarDashboard();
        } else {
          // Fallback se o login automático falhar
          dom.registerContainer.classList.add('hidden');
          dom.loginContainer.classList.remove('hidden');
        }
      } catch (err) {
        dom.registerContainer.classList.add('hidden');
        dom.loginContainer.classList.remove('hidden');
      }
    }, 2000);
    
  } catch (err) {
    dom.registerError.classList.remove('hidden');
    dom.registerErrorText.textContent = err.message;
  }
});

// ─── 🚪 LOGOUT ───
dom.btnLogout.addEventListener('click', () => {
  currentUser = null;
  localStorage.removeItem('saas_user');
  
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  
  dom.dashboardContainer.classList.add('hidden');
  dom.loginContainer.classList.remove('hidden');
});

// ─── 🤖 INICIALIZADOR DO DASHBOARD ───
function iniciarDashboard() {
  dom.loginContainer.classList.add('hidden');
  dom.dashboardContainer.classList.remove('hidden');
  
  dom.userNameDisplay.textContent = currentUser.nome;
  dom.welcomeMessage.textContent = `Olá, ${currentUser.nome.split(' ')[0]}! 👋`;
  
  // Conecta ao Socket.io
  conectarSocket();
  
  // Carrega lista de grupos monitorados
  carregarGrupos();
  
  // Inicializa a estrutura básica dos gráficos
  inicializarGraficos();
}

// ─── 🔌 CONECTAR WEBSOCKET (SOCKET.IO) ───
function conectarSocket() {
  socket = io();
  
  socket.on('connect', () => {
    console.log('🔌 Conectado ao servidor WebSocket com sucesso!');
    // Registra o cliente na sala exclusiva do usuário
    socket.emit('join_room', { usuarioId: currentUser.id });
  });
  
  // Recebe atualizações de status de conexão do WhatsApp
  socket.on('status', ({ status, qr, numero }) => {
    waStatus = status;
    atualizarInterfaceSessao(status, qr, numero);
  });
  
  // Monitoramento em tempo real: se chegar mensagem do grupo selecionado, recarrega gráficos!
  socket.on('nova_mensagem', ({ groupId }) => {
    if (selectedGroupId && selectedGroupId === groupId) {
      console.log('⚡ Nova mensagem detectada no grupo ativo! Recarregando dados...');
      carregarEstatisticasGrupo(selectedGroupId, true); // Recarrega silenciosamente
    }
  });

  // Recebe logs de segurança em tempo real
  socket.on('log_seguranca', (log) => {
    adicionarLogSeguranca(log);
  });
}

// ─── 📊 ATUALIZAR INTERFACE DA CONEXÃO WHATSAPP ───
function atualizarInterfaceSessao(status, qr, numero) {
  // 1. Atualizar badges de status na barra lateral (Sidebar)
  dom.sidebarStatusBadge.className = 'status-badge';
  dom.sidebarStatusBadge.classList.add(status === 'conectado' ? 'connected' : (status === 'desconectado' ? 'disconnected' : 'connecting'));
  
  const badgeText = dom.sidebarStatusBadge.querySelector('.text');
  
  if (status === 'conectado') {
    badgeText.textContent = `Conectado (${numero})`;
    dom.sidebarStatusBadge.classList.add('connected');
    
    // Ajustar botões e painéis principais
    dom.btnDisconnectWa.classList.remove('hidden');
    dom.btnConnectWa.classList.add('hidden');
    dom.waConnectionPanel.classList.add('hidden'); // Oculta o QR Code se estiver conectado
    dom.qrStatusText.textContent = 'WhatsApp Conectado';
  } else {
    dom.btnDisconnectWa.classList.add('hidden');
    dom.btnConnectWa.classList.remove('hidden');
    dom.waConnectionPanel.classList.remove('hidden'); // Exibe o QR Code para conectar
    
    if (status === 'inicializando') {
      badgeText.textContent = 'Inicializando...';
      dom.qrStatusText.textContent = 'Abrindo navegador invisível...';
      dom.qrPlaceholder.classList.remove('hidden');
      dom.qrcodeCanvas.classList.add('hidden');
      dom.qrPlaceholder.querySelector('span').textContent = 'Preparando servidor...';
      dom.qrPlaceholder.querySelector('i').className = 'fa-solid fa-spinner fa-spin';
    } else if (status === 'qr') {
      badgeText.textContent = 'Aguardando Escaneamento';
      dom.qrStatusText.textContent = 'Aguardando leitura do celular...';
      dom.qrPlaceholder.classList.add('hidden');
      dom.qrcodeCanvas.classList.remove('hidden');
      
      // Renderizar o QR Code dinamicamente
      renderizarQRCode(qr);
    } else {
      badgeText.textContent = 'Desconectado';
      dom.qrStatusText.textContent = 'WhatsApp Desconectado';
      dom.qrPlaceholder.classList.remove('hidden');
      dom.qrcodeCanvas.classList.add('hidden');
      dom.qrPlaceholder.querySelector('span').textContent = 'Aguardando Geração';
      dom.qrPlaceholder.querySelector('i').className = 'fa-solid fa-qrcode';
    }
  }
}

// Renderiza QR Code usando o canvas no navegador
function renderizarQRCode(qrText) {
  dom.qrcodeCanvas.innerHTML = ''; // Limpa anterior
  qrcodeInstance = new QRCode(dom.qrcodeCanvas, {
    text: qrText,
    width: 150,
    height: 150,
    colorDark: '#0f0c1b',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H
  });
}

// Triggers de ações de conexão/desconexão
dom.btnConnectWa.addEventListener('click', () => {
  if (socket) {
    socket.emit('conectar_whatsapp', { usuarioId: currentUser.id });
  }
});

dom.btnDisconnectWa.addEventListener('click', async () => {
  if (confirm('Tem certeza de que deseja desconectar o WhatsApp do painel? O monitoramento será pausado.')) {
    if (socket) {
      socket.emit('desconectar_whatsapp', { usuarioId: currentUser.id });
    }
  }
});

// ─── 👥 CARREGAR GRUPOS MONITORADOS ───
async function carregarGrupos() {
  try {
    const res = await fetch(`/api/groups?usuarioId=${currentUser.id}`);
    const grupos = await res.json();
    
    dom.gruposLista.innerHTML = '';
    
    if (grupos.length === 0) {
      dom.gruposLista.innerHTML = '<li class="grupo-item-placeholder">Nenhum grupo ativo monitorado</li>';
      return;
    }
    
    grupos.forEach(grupo => {
      const li = document.createElement('li');
      li.innerHTML = `
        <button class="grupo-btn ${selectedGroupId === grupo.id ? 'active' : ''}" data-id="${grupo.id}">
          <i class="fa-solid fa-users"></i>
          <span>${grupo.nome}</span>
        </button>
      `;
      dom.gruposLista.appendChild(li);
    });
    
    // Adiciona event listeners aos botões dos grupos
    document.querySelectorAll('.grupo-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const btnGrupo = e.currentTarget;
        const id = btnGrupo.getAttribute('data-id');
        
        document.querySelectorAll('.grupo-btn').forEach(b => b.classList.remove('active'));
        btnGrupo.classList.add('active');
        
        selecionarGrupo(id);
      });
    });
    
  } catch (err) {
    console.error('❌ Erro ao carregar grupos:', err.message);
  }
}

// Selecionar grupo e exibir dados
function selecionarGrupo(groupId) {
  selectedGroupId = groupId;
  dom.emptyStateSection.classList.add('hidden');
  dom.groupDetailsSection.classList.remove('hidden');
  
  if (window.innerWidth <= 900) {
    dom.sidebarMenu.classList.remove('active');
  }
  
  carregarEstatisticasGrupo(groupId);
}

// ─── 📊 OBTER E ATUALIZAR GRÁFICOS E TABELAS ───
async function carregarEstatisticasGrupo(groupId, silenciarFeedback = false) {
  const dias = dom.filterDias.value;
  const limite = dom.filterLimite.value;
  
  if (!silenciarFeedback) {
    // Exibe placeholder de loading na tabela
    dom.membrosTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="loading-td"><i class="fa-solid fa-spinner fa-spin"></i> Atualizando dados analíticos...</td>
      </tr>
    `;
  }
  
  try {
    const res = await fetch(`/api/stats/${groupId}?usuarioId=${currentUser.id}&dias=${dias}&limite=${limite}`);
    const stats = await res.json();
    
    dom.currentGroupName.innerHTML = `<i class="fa-solid fa-users-viewfinder"></i> Grupo: ${stats.nomeGrupo}`;
    
    // Atualiza contadores com animação simples
    animarContador(dom.statTotalMembros, stats.totais.total);
    animarContador(dom.statAtivos, stats.totais.ativos);
    animarContador(dom.statSilenciosos, stats.totais.silenciosos);
    animarContador(dom.statFantasmas, stats.totais.fantasmas);
    
    // Atualiza gráficos
    atualizarGraficos(stats);
    
    // Atualiza textareas com configurações do banco de dados local
    document.getElementById('input-keywords').value = (stats.termosProibidos || []).join(', ');
    document.getElementById('input-links').value = (stats.linksPermitidos || []).join(', ');
    
    // Atualiza tabela
    membrosGrupoCache = stats.membrosList;
    renderizarTabelaMembros(membrosGrupoCache);
    
  } catch (err) {
    console.error('❌ Erro ao carregar estatísticas:', err.message);
  }
}

// Animação de contagem incremental de números
function animarContador(elemento, valorFinal) {
  const valorInicial = parseInt(elemento.textContent) || 0;
  if (valorInicial === valorFinal) {
    elemento.textContent = valorFinal;
    return;
  }
  
  let current = valorInicial;
  const incremento = valorFinal > valorInicial ? Math.ceil((valorFinal - valorInicial) / 10) : Math.floor((valorFinal - valorInicial) / 10);
  
  const timer = setInterval(() => {
    current += incremento;
    if ((incremento > 0 && current >= valorFinal) || (incremento < 0 && current <= valorFinal)) {
      current = valorFinal;
      clearInterval(timer);
    }
    elemento.textContent = current;
  }, 30);
}

// ─── 🎨 INICIALIZAR GRÁFICOS APEXCHARTS ───
function inicializarGraficos() {
  // Destrói instâncias anteriores se houver
  if (chartPie) chartPie.destroy();
  if (chartBar) chartBar.destroy();
  
  // Configurações do Gráfico de Pizza (Donut)
  const optionsPie = {
    chart: {
      type: 'donut',
      height: 250,
      foreColor: '#a49fc6',
      animations: { enabled: true, easing: 'easeinout', speed: 800 }
    },
    labels: ['Ativos', 'Observadores', 'Fantasmas'],
    colors: ['#00ff87', '#ffb800', '#ff3838'],
    series: [0, 0, 0],
    dataLabels: { enabled: false },
    stroke: { colors: ['#0f0c1b'], width: 3 },
    legend: { position: 'bottom' },
    plotOptions: {
      pie: {
        donut: {
          size: '70%',
          background: 'transparent',
          labels: {
            show: true,
            total: {
              show: true,
              label: 'Total',
              color: '#ffffff',
              fontSize: '16px',
              fontFamily: 'Outfit, sans-serif',
              fontWeight: 600
            }
          }
        }
      }
    }
  };
  
  // Configurações do Gráfico de Barras (Ranking)
  const optionsBar = {
    chart: {
      type: 'bar',
      height: 250,
      foreColor: '#a49fc6',
      toolbar: { show: false },
      animations: { enabled: true, easing: 'easeinout', speed: 800 }
    },
    colors: ['#7d44ff'],
    series: [{
      name: 'Mensagens',
      data: []
    }],
    plotOptions: {
      bar: {
        borderRadius: 6,
        horizontal: false,
        columnWidth: '50%'
      }
    },
    dataLabels: { enabled: false },
    stroke: { show: true, width: 2, colors: ['transparent'] },
    xaxis: {
      categories: [],
      axisBorder: { show: false },
      axisTicks: { show: false }
    },
    fill: {
      type: 'gradient',
      gradient: {
        shade: 'dark',
        type: 'vertical',
        gradientToColors: ['#00f2fe'],
        stops: [0, 100]
      }
    },
    grid: {
      borderColor: 'rgba(255,255,255,0.05)',
      strokeDashArray: 4
    }
  };

  chartPie = new ApexCharts(document.querySelector("#chart-pie"), optionsPie);
  chartPie.render();

  chartBar = new ApexCharts(document.querySelector("#chart-bar"), optionsBar);
  chartBar.render();
}

// Atualizar a série de dados dos gráficos
function atualizarGraficos(stats) {
  // Gráfico Pizza
  chartPie.updateSeries([
    stats.totais.ativos,
    stats.totais.silenciosos,
    stats.totais.fantasmas
  ]);
  
  // Gráfico Barras (Ranking)
  const nomes = stats.ranking.map(m => m.nome || m.numero);
  const mensagens = stats.ranking.map(m => m.totalMensagens);
  
  chartBar.updateOptions({
    xaxis: { categories: nomes }
  });
  chartBar.updateSeries([{
    name: 'Mensagens',
    data: mensagens
  }]);
}

// ─── 📋 RENDERIZAR TABELA DE PARTICIPANTES ───
function renderizarTabelaMembros(membros) {
  dom.membrosTableBody.innerHTML = '';
  
  if (membros.length === 0) {
    dom.membrosTableBody.innerHTML = `
      <tr>
        <td colspan="8" class="loading-td">Nenhum membro encontrado com os critérios de filtro informados.</td>
      </tr>
    `;
    return;
  }
  
  membros.forEach(m => {
    let statusClass = 'badge-ativo';
    if (m.status.includes('Silencioso')) statusClass = 'badge-silencioso';
    if (m.status.includes('Fantasma') || m.status.includes('Inativo')) statusClass = 'badge-fantasma';
    
    const tr = document.createElement('tr');
    
    const adv = m.advertencias || 0;
    let warningClass = 'warning-0';
    if (adv === 1) warningClass = 'warning-1';
    if (adv >= 2) warningClass = 'warning-2';

    tr.innerHTML = `
      <td style="font-weight: 500; color: #fff;">${m.numero}</td>
      <td>${m.nome || '-'}</td>
      <td style="font-weight: 600;">${m.totalMensagens}</td>
      <td>${m.ultimaMensagem}</td>
      <td style="text-align: center;">${m.diasSemFalar}</td>
      <td style="text-align: center;">
        <span class="warning-badge ${warningClass}">${adv}/3</span>
        ${adv > 0 ? `
          <button class="btn-shield-reset" data-num="${m.numero}" title="Perdoar / Resetar Advertências">
            <i class="fa-solid fa-shield-heart"></i>
          </button>
        ` : ''}
      </td>
      <td><span class="table-badge ${statusClass}">${m.status}</span></td>
      <td>
        <button class="btn-ban-action" data-id="${m.id}" data-num="${m.numero}">
          <i class="fa-solid fa-user-slash"></i> Banir
        </button>
      </td>
    `;
    dom.membrosTableBody.appendChild(tr);
  });
  
  // Adiciona listeners para os botões de Banimento manual
  document.querySelectorAll('.btn-ban-action').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const num = e.currentTarget.getAttribute('data-num');
      banirMembroManual(num);
    });
  });

  // Adiciona listeners para os botões de Reset de Advertências
  document.querySelectorAll('.btn-shield-reset').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const num = e.currentTarget.getAttribute('data-num');
      perdoarAdvertenciasManual(num);
    });
  });
}

// ─── 🚫 AÇÃO: BANIR MEMBRO MANUALMENTE PELO PAINEL ───
async function banirMembroManual(numero) {
  if (confirm(`⚠️ ALERTA DE BANIMENTO:\nTem certeza que deseja remover o contato ${numero} do grupo?\nEsta ação será efetuada instantaneamente via robô no WhatsApp!`)) {
    try {
      const response = await fetch('/api/ban', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          usuarioId: currentUser.id,
          groupId: selectedGroupId,
          numero: numero
        })
      });

      const data = await response.json();
      if (response.ok && data.success) {
        alert(`✅ Sucesso: O contato ${numero} foi banido do grupo com sucesso!`);
        // Recarrega as estatísticas do grupo para atualizar a tabela na hora
        carregarEstatisticasGrupo(selectedGroupId);
      } else {
        alert(`❌ Erro ao banir: ${data.error || 'Erro desconhecido'}`);
      }
    } catch (err) {
      console.error('Erro de rede ao banir:', err);
      alert('❌ Erro de rede: Não foi possível conectar ao servidor para banir o membro.');
    }
  }
}

// ─── 🔍 FILTRAR TABELA EM TEMPO REAL ───
dom.membroSearch.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  
  if (query === '') {
    renderizarTabelaMembros(membrosGrupoCache);
    return;
  }
  
  const membrosFiltrados = membrosGrupoCache.filter(m => 
    m.numero.toLowerCase().includes(query) || 
    (m.nome && m.nome.toLowerCase().includes(query))
  );
  
  renderizarTabelaMembros(membrosFiltrados);
});

// Atualização de filtros dropdown
dom.filterDias.addEventListener('change', () => carregarEstatisticasGrupo(selectedGroupId));
dom.filterLimite.addEventListener('change', () => carregarEstatisticasGrupo(selectedGroupId));

// Botão Sincronizar
dom.btnSync.addEventListener('click', () => {
  if (selectedGroupId) {
    carregarGrupos();
    carregarEstatisticasGrupo(selectedGroupId);
  } else {
    carregarGrupos();
  }
});

// ─── 🏁 VERIFICAÇÃO AUTOMÁTICA DE LOGIN SALVO ───
window.addEventListener('DOMContentLoaded', () => {
  const savedUser = localStorage.getItem('saas_user');
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    iniciarDashboard();
  }
});

// ─── 🔑 CONFIGURAÇÕES: MODAL ALTERAR SENHA ───
dom.btnSettings.addEventListener('click', () => {
  dom.settingsModal.classList.remove('hidden');
  dom.currentPasswordInput.value = '';
  dom.newPasswordInput.value = '';
  dom.confirmNewPasswordInput.value = '';
  dom.passwordAlert.className = 'error-alert hidden';
  dom.passwordAlert.textContent = '';
});

dom.btnCloseModal.addEventListener('click', () => {
  dom.settingsModal.classList.add('hidden');
});

dom.settingsModal.addEventListener('click', (e) => {
  if (e.target === dom.settingsModal) {
    dom.settingsModal.classList.add('hidden');
  }
});

dom.changePasswordForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const currentPassword = dom.currentPasswordInput.value;
  const newPassword = dom.newPasswordInput.value;
  const confirmNew = dom.confirmNewPasswordInput.value;
  
  if (newPassword !== confirmNew) {
    dom.passwordAlert.className = 'error-alert';
    dom.passwordAlert.classList.remove('hidden');
    dom.passwordAlert.textContent = 'A nova senha e a confirmação não conferem!';
    return;
  }
  
  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usuarioId: currentUser.id,
        currentPassword,
        newPassword
      })
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Erro ao alterar a senha!');
    }
    
    dom.passwordAlert.className = 'alert-message success';
    dom.passwordAlert.classList.remove('hidden');
    dom.passwordAlert.innerHTML = '<i class="fa-solid fa-circle-check"></i> Senha alterada com sucesso!';
    
    setTimeout(() => {
      dom.settingsModal.classList.add('hidden');
    }, 2000);
  } catch (err) {
    dom.passwordAlert.className = 'error-alert';
    dom.passwordAlert.classList.remove('hidden');
    dom.passwordAlert.textContent = err.message;
  }
});

// ─── 📱 RESPONSIVIDADE: TOGGLE SIDEBAR CELULAR ───
dom.btnToggleSidebar.addEventListener('click', (e) => {
  e.stopPropagation();
  dom.sidebarMenu.classList.toggle('active');
});

// Fecha a barra lateral ao clicar fora dela
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 900) {
    if (!dom.sidebarMenu.contains(e.target) && e.target !== dom.btnToggleSidebar) {
      dom.sidebarMenu.classList.remove('active');
    }
  }
});

// ─── 🛡️ AÇÃO: PERDOAR / ZERAR ADVERTÊNCIAS ───
async function perdoarAdvertenciasManual(numero) {
  if (confirm(`🛡️ Resetar Infrações:\nDeseja zerar todas as advertências do contato ${numero}?\nO escudo protetor será ativado e sua contagem voltará para 0.`)) {
    try {
      const response = await fetch('/api/warnings/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          usuarioId: currentUser.id,
          groupId: selectedGroupId,
          numero: numero
        })
      });

      const data = await response.json();
      if (response.ok && data.success) {
        // Atualiza a tabela imediatamente
        carregarEstatisticasGrupo(selectedGroupId);
      } else {
        alert(`❌ Erro ao zerar advertências: ${data.error || 'Erro desconhecido'}`);
      }
    } catch (err) {
      console.error(err);
      alert('❌ Erro de rede: Não foi possível conectar ao servidor para redefinir advertências.');
    }
  }
}

// ─── 🛡️ SALVAR REGRAS DE CONFIGURAÇÃO DE MODERAÇÃO ───
document.getElementById('btn-salvar-config').addEventListener('click', async () => {
  if (!selectedGroupId) return;
  const btn = document.getElementById('btn-salvar-config');
  const originalHtml = btn.innerHTML;
  
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Salvando...`;
  
  const keywordsText = document.getElementById('input-keywords').value;
  const linksText = document.getElementById('input-links').value;
  
  const termos = keywordsText.split(',').map(s => s.trim()).filter(s => s.length > 0);
  const links = linksText.split(',').map(s => s.trim()).filter(s => s.length > 0);
  
  try {
    const resKeywords = await fetch(`/api/groups/${selectedGroupId}/keywords`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuarioId: currentUser.id, termos })
    });
    
    const resLinks = await fetch(`/api/groups/${selectedGroupId}/links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuarioId: currentUser.id, links })
    });
    
    if (resKeywords.ok && resLinks.ok) {
      btn.innerHTML = `<i class="fa-solid fa-check"></i> Regras Salvas!`;
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }, 1500);
    } else {
      throw new Error('Erro ao salvar as configurações.');
    }
  } catch (err) {
    console.error(err);
    alert('❌ Ocorreu um erro ao gravar as regras de moderação.');
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
});

// ─── 🤖 SIMULADOR GEMINI VISION IA (DRAG & DROP) ───
const dropzone = document.getElementById('dropzone-ia');
const fileInput = document.getElementById('file-ia');
const visionResult = document.getElementById('vision-result');

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    processarArquivoIA(files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    processarArquivoIA(e.target.files[0]);
  }
});

async function processarArquivoIA(file) {
  if (!file.type.startsWith('image/')) {
    alert('Por favor, selecione apenas arquivos de imagem.');
    return;
  }
  
  visionResult.className = 'vision-result';
  visionResult.classList.remove('hidden');
  visionResult.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Simulando análise do Gemini Vision...`;
  
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = async () => {
    const base64Content = reader.result.split(',')[1];
    const mimeType = file.type;
    
    try {
      const response = await fetch('/api/ia/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Data: base64Content, mimeType })
      });
      
      const data = await response.json();
      if (response.ok && data.success) {
        const isSafe = data.resultado === 'NÃO';
        if (isSafe) {
          visionResult.className = 'vision-result safe';
          visionResult.innerHTML = `<i class="fa-solid fa-circle-check"></i> <strong>IMAGEM SEGURA:</strong> O Gemini permitiu o envio.`;
        } else {
          visionResult.className = 'vision-result unsafe';
          visionResult.innerHTML = `<i class="fa-solid fa-triangle-exclamation animate-bounce"></i> <strong>CONTEÚDO IMPRÓPRIO DETECTADO:</strong> Imagem violenta ou spam (O bot iria apagar!).`;
        }
      } else {
        visionResult.className = 'vision-result unsafe';
        visionResult.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> <strong>ERRO:</strong> ${data.error || 'Falha na verificação.'}`;
      }
    } catch (err) {
      console.error(err);
      visionResult.className = 'vision-result unsafe';
      visionResult.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Erro ao conectar ao servidor de IA.`;
    }
  };
}

// ─── 📥 EXPORTADOR CSV PROFISSIONAL ───
document.getElementById('btn-export-csv').addEventListener('click', () => {
  if (membrosGrupoCache.length === 0) {
    alert('Nenhum dado disponível para exportar.');
    return;
  }
  
  const headers = ['Número', 'Nome do WhatsApp', 'Mensagens', 'Última Interação', 'Dias Sem Falar', 'Advertências', 'Status'];
  const rows = membrosGrupoCache.map(m => [
    m.numero,
    m.nome || '',
    m.totalMensagens,
    m.ultimaMensagem,
    m.diasSemFalar,
    m.advertencias || 0,
    m.status
  ]);
  
  const csvContent = [headers, ...rows]
    .map(row => row.map(val => `"${String(val).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n');
    
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  
  const nomeGrupoFormatado = dom.currentGroupName.textContent.replace('Grupo: ', '').trim().replace(/[^a-z0-9]/gi, '_');
  link.setAttribute('download', `auditoria_membros_${nomeGrupoFormatado}_${new Date().toLocaleDateString('pt-BR').replace(/\//g, '-')}.csv`);
  link.style.visibility = 'hidden';
  
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

// ─── 🛡️ CENTRAL DE LOGS EM TEMPO REAL ───
let logsCount = 0;

function adicionarLogSeguranca(log) {
  const panel = document.getElementById('live-logs-panel');
  const badge = document.getElementById('logs-count');
  const body = document.getElementById('logs-body');
  
  const noLogs = body.querySelector('.no-logs');
  if (noLogs) {
    noLogs.remove();
  }
  
  logsCount++;
  badge.textContent = logsCount;
  
  const item = document.createElement('div');
  item.className = 'log-item';
  
  const time = log.timestamp || new Date().toLocaleTimeString();
  const grupo = log.grupo || 'Grupo';
  const membro = log.membro || '';
  const nome = log.nome || 'Membro';
  const motivo = log.motivo || 'conteúdo impróprio';
  const acao = log.acao || 'DELETE';
  const badgeClass = acao.toLowerCase() === 'ban' ? 'ban' : 'delete';
  const badgeLabel = acao.toUpperCase();
  
  item.innerHTML = `
    <div class="log-item-header">
      <span class="log-time">[${time}]</span>
      <span class="log-badge-acao ${badgeClass}">${badgeLabel}</span>
    </div>
    <div>Grupo: <strong>${grupo}</strong></div>
    <div>Membro: <span class="log-membro">${nome} (${membro})</span></div>
    <div>Motivo: <span class="log-motivo">${motivo}</span></div>
  `;
  
  body.insertBefore(item, body.firstChild);
  
  if (panel.classList.contains('collapsed')) {
    panel.classList.add('pulse-alert');
    setTimeout(() => panel.classList.remove('pulse-alert'), 1000);
  }
}

document.getElementById('logs-header').addEventListener('click', (e) => {
  const panel = document.getElementById('live-logs-panel');
  const chevron = document.getElementById('btn-toggle-logs').querySelector('i');
  
  panel.classList.toggle('collapsed');
  if (panel.classList.contains('collapsed')) {
    chevron.className = 'fa-solid fa-chevron-up';
  } else {
    chevron.className = 'fa-solid fa-chevron-down';
  }
});

document.getElementById('btn-clear-logs').addEventListener('click', (e) => {
  e.stopPropagation();
  const body = document.getElementById('logs-body');
  const badge = document.getElementById('logs-count');
  body.innerHTML = '<div class="no-logs">Nenhuma atividade de moderação registrada nesta sessão.</div>';
  logsCount = 0;
  badge.textContent = '0';
});
