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
        ${c.horario_entrega ? `<div class="code">Horario: ${escapeHtml(c.horario_entrega)}</div>` : ''}
      </div>
      <div class="right-side">
        <div class="cat-badges">${(c.categorias || []).map(cat => `<span class="cat-badge" title="${escapeHtml(cat)}">${CAT_ICONS[cat] || ''}</span>`).join('')}${c.isotonicas ? `<span class="cat-badge" title="Isotónicas">${ISOTONICA_ICON}</span>` : ''}</div>
        <div class="arrow">›</div>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('.client-item').forEach(item => {
    item.onclick = () => openCliente(item.getAttribute('data-id'));
  });
}
document.querySelectorAll('.cat-card').forEach(el => {
  el.addEventListener('click', () => openCategoria(el.getAttribute('data-cat')));
});
document.getElementById('searchBox').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) { renderClientList(currentClientList); return; }
  const filtered = currentClientList.filter(c =>
    String(c.cliente_id).toLowerCase().includes(q) ||
    (c.razon_social || '').toLowerCase().includes(q) ||
    (c.domicilio || '').toLowerCase().includes(q)
  );
  renderClientList(filtered);
});
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
// ---------- Pantalla 1b: clientes que compraron una categoria ----------
async function openCategoria(categoria) {
  const vendedor = vendedorSelect.getValue();
  const dia = diaSelect.getValue();
  if (!vendedor || !dia) return;
  showScreen('screenCategoria');
  document.getElementById('categoriaTitle').textContent = `${CAT_ICONS[categoria]} ${categoria}`;
  const content = document.getElementById('categoriaContent');
  content.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    const rows = await api(`/api/clientes/categoria?vendedor=${encodeURIComponent(vendedor)}&dia=${encodeURIComponent(dia)}&categoria=${encodeURIComponent(categoria)}`);
    renderCategoriaClientes(rows);
  } catch (e) {
    content.innerHTML = '<div class="empty-msg">No se pudo cargar.</div>';
  }
}
function renderCategoriaClientes(list) {
  const content = document.getElementById('categoriaContent');
  if (!list.length) { content.innerHTML = '<div class="empty-msg">No hay clientes para mostrar.</div>'; return; }
  content.innerHTML = list.map(c => `
    <div class="client-item" data-id="${escapeHtml(c.cliente_id)}">
      <div>
        <div class="name">${escapeHtml(c.razon_social || '(sin nombre)')}</div>
        <div class="addr">${escapeHtml(c.domicilio || '')}</div>
        <div class="code">Código: ${escapeHtml(c.cliente_id)}</div>
        ${c.horario_entrega ? `<div class="code">Horario: ${escapeHtml(c.horario_entrega)}</div>` : ''}
      </div>
      <div class="right-side">
        <div class="cat-badges">${(c.categorias || []).map(cat => `<span class="cat-badge" title="${escapeHtml(cat)}">${CAT_ICONS[cat] || ''}</span>`).join('')}${c.isotonicas ? `<span class="cat-badge" title="Isotónicas">${ISOTONICA_ICON}</span>` : ''}</div>
        <div class="arrow">›</div>
      </div>
    </div>
  `).join('');
  content.querySelectorAll('.client-item').forEach(item => {
    item.onclick = () => openCliente(item.getAttribute('data-id'));
  });
}
document.getElementById('btnBackFromCategoria').onclick = goBack;
// ---------- Pantalla 2: detalle de cliente ----------
const CAT_ICONS = { 'Cervezas':'🍺', 'Aguas':'💧', 'Vinos':'🍷', 'Sidras':'🍏' };
const CAT_COLORS = { 'Cervezas':'var(--cerveza)', 'Aguas':'var(--agua)', 'Vinos':'var(--vinos)', 'Sidras':'var(--sidras)' };
// Isotonicas no tiene emoji propio - se dibuja una botellita roja chica en
// SVG inline (mismo tamaño que los emoji de CAT_ICONS) en vez de buscar un
// emoji parecido, para que quede exactamente lo que pidio el usuario.
const ISOTONICA_ICON = '<svg width="13" height="15" viewBox="0 0 13 15" style="vertical-align:-2px;"><rect x="5" y="0" width="3" height="2.5" rx="0.5" fill="#8a2420"/><path d="M4 2.5H9V4.3C10.1 5.1 10.7 6.2 10.7 7.5V12.5C10.7 13.9 9.6 15 8.2 15H4.8C3.4 15 2.3 13.9 2.3 12.5V7.5C2.3 6.2 2.9 5.1 4 4.3V2.5Z" fill="#e03b3b"/></svg>';
let currentClienteId = null;
let currentClienteData = null;
async function openCliente(id) {
  currentClienteId = id;
  currentClienteData = null;
  showScreen('screenCliente');
  const content = document.getElementById('clienteContent');
  content.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    const data = await api('/api/cliente/' + encodeURIComponent(id));
    currentClienteData = data.cliente;
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
// ---------- Pantalla 2a: datos del cliente (universo) ----------
// Usa los datos que ya trajo openCliente() (currentClienteData, el objeto
// "cliente" de /api/cliente/:id - ya incluye las columnas nuevas de la
// tabla clientes) en vez de pedirlos de nuevo al servidor.
document.getElementById('btnDatos').onclick = () => { if (currentClienteData) openDatos(); };
document.getElementById('btnBackFromDatos').onclick = goBack;
function datoRow(label, value) {
  return `<div class="dato-row"><div class="dato-label">${escapeHtml(label)}</div><div class="dato-value">${escapeHtml(value || '-')}</div></div>`;
}
function openDatos() {
  showScreen('screenDatos');
  const d = currentClienteData;
  const entreCalle = [d.calle1, d.calle2].filter(Boolean).join(' y ');
  document.getElementById('datosContent').innerHTML = `
    <div class="cliente-header">
      <div class="name">${escapeHtml(d.razon_social)}</div>
      <div class="addr">Código ${escapeHtml(d.cliente_id)}</div>
    </div>
    ${datoRow('Dirección', d.calle)}
    ${datoRow('Entre calle', entreCalle)}
    ${datoRow('Localidad', d.localidad)}
    ${datoRow('Horario de entrega', d.horario_entrega)}
    ${datoRow('Ramo', d.ramo)}
    ${datoRow('Categoría', d.categoria_cliente)}
    ${datoRow('Vendedor', d.personal_comercial)}
    ${datoRow('Día de visita', d.dias_visita)}
  `;
}
// ---------- Pantalla 2b: historico del cliente (mes actual vs mes anterior) ----------
document.getElementById('btnHistorico').onclick = () => { if (currentClienteId) openHistorico(currentClienteId); };
document.getElementById('btnBackFromHistorico').onclick = goBack;
const CATS_HIST = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
let historicoMeses = { actual: '', anterior: '' };
async function openHistorico(id) {
  showScreen('screenHistorico');
  const content = document.getElementById('historicoContent');
  content.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    const data = await api('/api/cliente/' + encodeURIComponent(id) + '/historico');
    historicoMeses = { actual: data.nombre_mes_actual, anterior: data.nombre_mes_anterior };
    document.getElementById('historicoTitle').textContent = `${data.nombre_mes_actual} vs ${data.nombre_mes_anterior}`;
    renderHistorico(data);
  } catch (e) {
    content.innerHTML = '<div class="empty-msg">No se pudo cargar el histórico.</div>';
  }
}
// Donut de 2 porciones (mes actual / mes anterior) armado con 2 <circle>
// superpuestos y stroke-dasharray/stroke-dashoffset - no hace falta ninguna
// libreria de graficos para un comparativo tan simple de 2 valores.
function renderDonut(totalActual, totalAnterior, colorActual) {
  const total = totalActual + totalAnterior;
  if (total <= 0) return '';
  const r = 40, strokeW = 16, c = 2 * Math.PI * r;
  const dashActual = (totalActual / total) * c;
  const dashAnterior = (totalAnterior / total) * c;
  return `
    <svg viewBox="0 0 100 100" class="donut" role="img" aria-label="Comparación ${historicoMeses.actual} vs ${historicoMeses.anterior}">
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--text3)" stroke-width="${strokeW}"
        stroke-dasharray="${dashAnterior} ${c}" stroke-dashoffset="${-dashActual}" transform="rotate(-90 50 50)"></circle>
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="${colorActual}" stroke-width="${strokeW}"
        stroke-dasharray="${dashActual} ${c}" transform="rotate(-90 50 50)"></circle>
    </svg>
  `;
}
function renderHistoricoCategoria(cat, catData) {
  const colorActual = CAT_COLORS[cat];
  const totalActual = catData.total_actual || 0;
  const totalAnterior = catData.total_anterior || 0;
  let badge = '';
  if (totalAnterior > 0) {
    const varPct = Math.round(((totalActual - totalAnterior) / totalAnterior) * 1000) / 10;
    badge = `<span class="hist-badge ${varPct >= 0 ? 'hist-up' : 'hist-down'}">${varPct >= 0 ? '+' : ''}${varPct}%</span>`;
  }
  const chart = (totalActual > 0 || totalAnterior > 0) ? `
    <div class="hist-chart-row">
      ${renderDonut(totalActual, totalAnterior, colorActual)}
      <div class="hist-legend">
        <div class="hist-legend-row"><span class="dot" style="background:${colorActual}"></span>${escapeHtml(historicoMeses.actual)} (a la fecha)<b>${fmt1(totalActual)} HL</b></div>
        <div class="hist-legend-row"><span class="dot" style="background:var(--text3)"></span>${escapeHtml(historicoMeses.anterior)}<b>${fmt1(totalAnterior)} HL</b></div>
      </div>
    </div>
  ` : '<div class="hist-sin-datos">Sin compras para comparar este mes.</div>';
  const marcas = catData.marcas || [];
  const marcasHtml = marcas.length ? marcas.map(m => `
    <div class="hist-marca-row" data-marca="${escapeHtml(m.marca)}">
      <div class="hist-marca-name">${escapeHtml(m.marca)}</div>
      <div class="hist-marca-vals">
        <span class="hist-val-ant">${fmt1(m.hl_anterior)} HL</span>
        <span class="hist-val-arrow">→</span>
        <span class="hist-val-act">${fmt1(m.hl_actual)} HL</span>
      </div>
    </div>
  `).join('') : '<div class="sin-compra">Sin compras en estos 2 meses</div>';
  return `
    <div class="cat-section" style="--c:${colorActual};">
      <div class="cat-title">${CAT_ICONS[cat]} ${cat}${badge}</div>
      ${chart}
      <div class="hist-marcas">${marcasHtml}</div>
    </div>
  `;
}
function renderHistorico(data) {
  const content = document.getElementById('historicoContent');
  content.innerHTML = CATS_HIST.map(cat => renderHistoricoCategoria(cat, data.categorias[cat] || { marcas: [], total_actual: 0, total_anterior: 0 })).join('');
  content.querySelectorAll('.hist-marca-row').forEach(el => {
    el.onclick = () => openHistoricoMarca(currentClienteId, el.getAttribute('data-marca'));
  });
}
// ---------- Pantalla 2c: historico por articulo de una marca ----------
document.getElementById('btnBackFromHistoricoMarca').onclick = goBack;
async function openHistoricoMarca(clienteId, marca) {
  showScreen('screenHistoricoMarca');
  document.getElementById('historicoMarcaTitle').textContent = marca;
  const content = document.getElementById('historicoMarcaContent');
  content.innerHTML = '<div class="loading">Cargando...</div>';
  try {
    const data = await api(`/api/cliente/${encodeURIComponent(clienteId)}/historico/marca/${encodeURIComponent(marca)}`);
    if (!data.filas.length) {
      content.innerHTML = '<div class="empty-msg">Sin artículos para mostrar.</div>';
      return;
    }
    content.innerHTML = `<p class="hist-sin-datos" style="margin:-6px 0 12px;">${escapeHtml(data.nombre_mes_anterior)} → ${escapeHtml(data.nombre_mes_actual)}</p>` + data.filas.map(r => `
      <div class="hist-marca-row">
        <div class="hist-marca-name">${escapeHtml(r.articulo)}</div>
        <div class="hist-marca-vals">
          <span class="hist-val-ant">${fmt1(r.hl_anterior)} HL</span>
          <span class="hist-val-arrow">→</span>
          <span class="hist-val-act">${fmt1(r.hl_actual)} HL</span>
        </div>
      </div>
    `).join('');
  } catch (e) {
    content.innerHTML = '<div class="empty-msg">No se pudo cargar.</div>';
  }
}
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
