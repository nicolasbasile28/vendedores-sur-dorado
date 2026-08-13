// app.js - Logica de la app de vendedores (sin frameworks, vanilla JS)
const API = ''; // mismo origen
// ---------- Sesion persistente (tipo WhatsApp) ----------
function saveSession(token, role, username) {
  localStorage.setItem('sd_token', token);
  localStorage.setItem('sd_role', role);
  localStorage.setItem('sd_username', username);
}
function getSession() {
  const token = localStorage.getItem('sd_token');
  if (!token) return null;
  return { token, role: localStorage.getItem('sd_role'), username: localStorage.getItem('sd_username') };
}
function clearSession() {
  localStorage.removeItem('sd_token');
  localStorage.removeItem('sd_role');
  localStorage.removeItem('sd_username');
}
async function api(path, opts = {}) {
  const session = getSession();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (session) headers['Authorization'] = 'Bearer ' + session.token;
  const res = await fetch(API + path, Object.assign({}, opts, { headers }));
  if (res.status === 401) {
    clearSession();
    showScreen('screenLogin');
    throw new Error('Sesion expirada');
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}
// ---------- Navegacion entre pantallas ----------
let screenStack = [];
function showScreen(id, opts = {}) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (!opts.noPush) screenStack.push(id);
}
function goBack() {
  screenStack.pop();
  const prev = screenStack.pop() || 'screenSelector';
  showScreen(prev);
}
// ---------- Login ----------
document.getElementById('btnLogin').onclick = doLogin;
document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  if (!username || !password) { errEl.textContent = 'Completá usuario y contraseña.'; return; }
  try {
    const res = await fetch(API + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.error || 'Error al ingresar.'; return; }
    saveSession(data.token, data.role, data.username);
    afterLogin();
  } catch (e) {
    errEl.textContent = 'No se pudo conectar con el servidor.';
  }
}
document.getElementById('btnLogout').onclick = () => {
  api('/api/logout', { method: 'POST' }).catch(() => {});
  clearSession();
  screenStack = [];
  showScreen('screenLogin', { noPush: true });
};
async function afterLogin() {
  screenStack = [];
  showScreen('screenSelector', { noPush: true });
  updateVisorLink();
  await loadVendedores();
}
function updateVisorLink() {
  const link = document.getElementById('linkVisor');
  if (!link) return;
  const session = getSession();
  const puedeVerVisor = session && ['admin', 'supervisor'].includes(session.role);
  link.style.display = puedeVerVisor ? 'inline' : 'none';
}
// ---------- Pantalla 1: selector + lista de clientes ----------
let currentClientList = [];
function makeCustomSelect(btnId, panelId, onSelect){
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  function close(){ panel.classList.remove('open'); }
  function open(){ panel.classList.add('open'); }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    if (panel.classList.contains('open')) close(); else open();
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== btn) close();
  });
  return {
    setOptions(options, placeholder){
      panel.innerHTML = options.map(o =>
        `<div class="cselect-option" data-value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</div>`
      ).join('');
      panel.querySelectorAll('.cselect-option').forEach(el => {
        el.addEventListener('click', () => {
          const value = el.getAttribute('data-value');
          btn.textContent = el.textContent;
          btn.dataset.value = value;
          close();
          onSelect(value);
        });
      });
      if (placeholder !== undefined) btn.textContent = placeholder;
      btn.dataset.value = '';
    },
    enable(){ btn.disabled = false; },
    disable(text){ btn.disabled = true; if (text) btn.textContent = text; btn.dataset.value = ''; },
    getValue(){ return btn.dataset.value || ''; },
    close,
  };
}
const vendedorSelect = makeCustomSelect('cselVendedorBtn', 'cselVendedorPanel', async (vendedor) => {
  document.getElementById('resultsArea').style.display = 'none';
  if (!vendedor) {
    diaSelect.disable('Elegí un vendedor primero');
    return;
  }
  diaSelect.enable();
  diaSelect.setOptions([], 'Cargando...');
  const dias = await api('/api/dias?vendedor=' + encodeURIComponent(vendedor));
  diaSelect.setOptions(dias.map(d => ({ value: d, label: d })), 'Elegí un día...');
});
const diaSelect = makeCustomSelect('cselDiaBtn', 'cselDiaPanel', async (dia) => {
  const vendedor = vendedorSelect.getValue();
  if (!vendedor || !dia) { document.getElementById('resultsArea').style.display = 'none'; return; }
  await loadClientes(vendedor, dia);
});
diaSelect.disable('Elegí un vendedor primero');
async function loadVendedores() {
  vendedorSelect.setOptions([], 'Cargando...');
  try {
    const vendedores = await api('/api/vendedores');
    vendedorSelect.setOptions(vendedores.map(v => ({ value: v, label: v })), 'Elegí un vendedor...');
  } catch (e) {
    vendedorSelect.setOptions([], 'Error al cargar');
  }
}
async function loadClientes(vendedor, dia) {
  const area = document.getElementById('resultsArea');
  area.style.display = '';
  document.getElementById('clientList').innerHTML = '<div class="loading">Cargando...</div>';
  const data = await api(`/api/clientes?vendedor=${encodeURIComponent(vendedor)}&dia=${encodeURIComponent(dia)}`);
  currentClientList = data.clientes;
  document.getElementById('totalClientes').textContent = data.total_clientes;
  document.getElementById('numCervezas').textContent = data.compradores_por_categoria.Cervezas || 0;
  document.getElementById('numAguas').textContent = data.compradores_por_categoria.Aguas || 0;
  document.getElementById('numVinos').textContent = data.compradores_por_categoria.Vinos || 0;
  document.getElementById('numSidras').textContent = data.compradores_por_categoria.Sidras || 0;
  document.getElementById('searchBox').value = '';
  renderClientList(currentClientList);
}
function renderClientList(list) {
  const el = document.getElementById('clientList');
  if (!list.length) { el.innerHTML = '<div class="empty-msg">No hay clientes para mostrar.</div>'; return; }
  el.innerHTML = list.map(c => `
    <div class="client-item" data-id="${escapeHtml(c.cliente_id)}">
      <div>
        <div class="name">${escapeHtml(c.razon_social || '(sin nombre)')}</div>
        <div class="addr">${escapeHtml(c.domicilio || '')}</div>
        <div class="code">Código: ${escapeHtml(c.cliente_id)}</div>
      </div>
      <div class="arrow">›</div>
    </div>
  `).join('');
  el.querySelectorAll('.client-item').forEach(item => {
    item.onclick = () => openCliente(item.getAttribute('data-id'));
  });
}
document.getElementById('searchBox').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderClientList(currentClientList); return; }
  const filtered = currentClientList.filter(c =>
    String(c.cliente_id).toLowerCase().includes(q) ||
    (c.razon_social || '').toLowerCase().includes(q)
  );
  renderClientList(filtered);
});
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
// ---------- Pantalla 2: detalle de cliente ----------
const CAT_ICONS = { 'Cervezas':'🍺', 'Aguas':'💧', 'Vinos':'🍷', 'Sidras':'🍏' };
const CAT_COLORS = { 'Cervezas':'var(--cerveza)', 'Aguas':'var(--agua)', 'Vinos':'var(--vinos)', 'Sidras':'var(--sidras)' };
let currentClienteId = null;
async function openCliente(id) {
  currentClienteId = id;
  showScreen('screenCliente');
  const content = document.getElementById('clienteContent');
  content.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    const data = await api('/api/cliente/' + encodeURIComponent(id));
    renderCliente(data);
  } catch (e) {
    content.innerHTML = '<div class="empty-msg">No se pudo cargar el cliente.</div>';
  }
}
function renderCliente(data) {
  const content = document.getElementById('clienteContent');
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  let html = `
    <div class="cliente-header">
      <div class="name">${escapeHtml(data.cliente.razon_social)}</div>
      <div class="addr">${escapeHtml(data.cliente.domicilio)} · Código ${escapeHtml(data.cliente.cliente_id)}</div>
    </div>
  `;
  CATS.forEach(cat => {
    const marcas = data.compras[cat] || [];
    html += `<div class="cat-section" style="--c:${CAT_COLORS[cat]};">
      <div class="cat-title">${CAT_ICONS[cat]} ${cat}</div>`;
    if (!marcas.length) {
      html += `<div class="sin-compra">Sin compra</div>`;
    } else {
      marcas.forEach(m => {
        html += `<div class="marca-row">
          <div class="mname" data-marca="${escapeHtml(m.marca)}">${escapeHtml(m.marca)}</div>
          <div class="mhl">${fmt1(m.hl)} HL</div>
        </div>`;
      });
    }
    html += `</div>`;
  });
  content.innerHTML = html;
  content.querySelectorAll('.mname').forEach(el => {
    el.onclick = () => openMarca(currentClienteId, el.getAttribute('data-marca'));
  });
}
document.getElementById('btnBackFromCliente').onclick = goBack;
// ---------- Pantalla 3: articulos de una marca ----------
async function openMarca(clienteId, marca) {
  showScreen('screenMarca');
  document.getElementById('marcaTitle').textContent = marca;
  const content = document.getElementById('marcaContent');
  content.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    const rows = await api(`/api/cliente/${encodeURIComponent(clienteId)}/marca/${encodeURIComponent(marca)}`);
    if (!rows.length) {
      content.innerHTML = '<div class="empty-msg">Sin artículos para mostrar.</div>';
      return;
    }
    content.innerHTML = rows.map(r => `
      <div class="art-row">
        <div class="aname">${escapeHtml(r.articulo)}</div>
        <div class="ahl">${fmt1(r.hl)} HL</div>
      </div>
    `).join('');
  } catch (e) {
    content.innerHTML = '<div class="empty-msg">No se pudo cargar.</div>';
  }
}
document.getElementById('btnBackFromMarca').onclick = goBack;
function fmt1(n) {
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
// ---------- Saludo dinamico ----------
function setGreeting() {
  const h = new Date().getHours();
  let g = 'Buen día, vamos a trabajar';
  if (h >= 12 && h < 19) g = 'Buenas tardes, vamos a trabajar';
  else if (h >= 19 || h < 6) g = 'Buenas noches, vamos a trabajar';
  document.getElementById('greetingText').textContent = g;
}
// ---------- Arranque ----------
(function init() {
  setGreeting();
  const session = getSession();
  if (session) {
    afterLogin();
  } else {
    showScreen('screenLogin', { noPush: true });
  }
})();
// ---------- Service worker (para poder instalarla) ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
