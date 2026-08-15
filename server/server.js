
// server.js - Servidor HTTP principal (sin dependencias externas, solo Node)
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');
const authLib = require('./auth');
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// ---------- Utilidades ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 60 * 1024 * 1024) {
        reject(new Error('Body demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function getAuth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  return authLib.getSession(token);
}
function requireAuth(req, res, roles) {
  const session = getAuth(req);
  if (!session) {
    sendJson(res, 401, { error: 'No autenticado' });
    return null;
  }
  if (roles && !roles.includes(session.role)) {
    sendJson(res, 403, { error: 'No autorizado' });
    return null;
  }
  return session;
}
const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const parts = r.pattern.split('/').filter(Boolean);
    const pparts = pathname.split('/').filter(Boolean);
    if (parts.length !== pparts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].startsWith(':')) {
        params[parts[i].slice(1)] = decodeURIComponent(pparts[i]);
      } else if (parts[i] !== pparts[i]) {
        ok = false; break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}
route('POST', '/api/login', async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  const result = authLib.login(body.username || '', body.password || '');
  if (!result) return sendJson(res, 401, { error: 'Usuario o contraseña incorrectos' });
  sendJson(res, 200, result);
});
route('POST', '/api/logout', async (req, res) => {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) authLib.logout(token);
  sendJson(res, 200, { ok: true });
});
route('GET', '/api/vendedores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const rows = db.prepare(`
    SELECT DISTINCT personal_comercial FROM clientes
    WHERE personal_comercial IS NOT NULL AND personal_comercial != ''
    ORDER BY personal_comercial
  `).all();
  sendJson(res, 200, rows.map(r => r.personal_comercial));
});
route('GET', '/api/dias', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const vendedor = parsed.query.vendedor || '';
  const rows = db.prepare(`
    SELECT DISTINCT dias_visita FROM clientes
    WHERE personal_comercial = ? AND dias_visita IS NOT NULL AND dias_visita != ''
    ORDER BY dias_visita
  `).all(vendedor);
  sendJson(res, 200, rows.map(r => r.dias_visita));
});
route('GET', '/api/clientes', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const vendedor = parsed.query.vendedor || '';
  const dia = parsed.query.dia || '';
  const clientes = db.prepare(`
    SELECT cliente_id, razon_social, domicilio FROM clientes
    WHERE personal_comercial = ? AND dias_visita = ?
    ORDER BY razon_social
  `).all(vendedor, dia);
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const compradoresPorCat = {};
  for (const cat of CATS) {
    const rows = db.prepare(`
      SELECT DISTINCT v.cliente_id FROM ventas v
      JOIN clientes c ON c.cliente_id = v.cliente_id
      WHERE c.personal_comercial = ? AND c.dias_visita = ? AND v.categoria = ?
      GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
    `).all(vendedor, dia, cat);
    compradoresPorCat[cat] = rows.length;
  }
  sendJson(res, 200, {
    total_clientes: clientes.length,
    compradores_por_categoria: compradoresPorCat,
    clientes,
  });
});
route('GET', '/api/cliente/:id', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const cliente = db.prepare('SELECT * FROM clientes WHERE cliente_id = ?').get(params.id);
  if (!cliente) return sendJson(res, 404, { error: 'Cliente no encontrado' });
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const resultado = {};
  for (const cat of CATS) {
    const rows = db.prepare(`
      SELECT marca, SUM(um_hl) as hl FROM ventas
      WHERE cliente_id = ? AND categoria = ?
      GROUP BY marca HAVING SUM(um_hl) >= 0.001
      ORDER BY hl DESC
    `).all(params.id, cat);
    resultado[cat] = rows;
  }
  sendJson(res, 200, { cliente, compras: resultado });
});
route('GET', '/api/cliente/:id/marca/:marca', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const rows = db.prepare(`
    SELECT articulo, SUM(um_hl) as hl FROM ventas
    WHERE cliente_id = ? AND marca = ?
    GROUP BY articulo HAVING SUM(um_hl) >= 0.001
    ORDER BY hl DESC
  `).all(params.id, params.marca);
  sendJson(res, 200, rows);
});
route('POST', '/api/upload', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  const raw = (await readBody(req)).toString('utf-8');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const { clientes, ventas, mes_actual, mes, anio, dias_venta_reales } = data;
  if (!Array.isArray(clientes) || !Array.isArray(ventas)) {
    return sendJson(res, 400, { error: 'Formato invalido: se esperaba {clientes:[], ventas:[]}' });
  }
  db.exec('BEGIN');
  try {
    // Conserva el historico: si viene mes/anio, solo se borra y reemplaza ESE periodo.
    // Si no viene (compatibilidad con subidas viejas), se borra todo como antes.
    if (mes && anio) {
      db.prepare('DELETE FROM ventas WHERE mes = ? AND anio = ?').run(Number(mes), Number(anio));
    } else {
      db.exec('DELETE FROM ventas');
    }
    // Los clientes se actualizan por cliente_id (INSERT OR REPLACE), no se borra el universo completo.
    const insCliente = db.prepare(`
      INSERT OR REPLACE INTO clientes (cliente_id, razon_social, domicilio, personal_comercial, dias_visita)
      VALUES (?,?,?,?,?)
    `);
    for (const c of clientes) {
      insCliente.run(String(c.cliente_id), c.razon_social || '', c.domicilio || '', c.personal_comercial || '', c.dias_visita || '');
    }
    const insVenta = db.prepare(`
      INSERT INTO ventas (cliente_id, categoria, marca, articulo, um_hl, supervisor, camionero, tipo_documento, mes, anio) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    for (const v of ventas) {
      insVenta.run(String(v.cliente_id), v.categoria, v.marca, v.articulo, Number(v.um_hl) || 0, v.supervisor || null, v.camionero || null, v.tipo_documento || null, v.mes || null, v.anio || null);
    }
    const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)');
    setMeta.run('mes_actual', mes_actual || '');
    setMeta.run('last_upload', new Date().toISOString());
    if (mes && anio) {
      setMeta.run('mes_actual_num', String(mes));
      setMeta.run('anio_actual_num', String(anio));
    }
    if (mes && anio && dias_venta_reales) {
      setMeta.run(`dias_reales_${anio}_${String(mes).padStart(2, '0')}`, String(dias_venta_reales));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return sendJson(res, 500, { error: 'Error guardando datos: ' + e.message });
  }
  sendJson(res, 200, { ok: true, clientes: clientes.length, ventas: ventas.length });
});
 
// Arma la clausula WHERE y el JOIN necesarios segun los filtros opcionales que vengan en el query string
function buildFiltros(query) {
  const filtros = { supervisor: query.supervisor || '', camionero: query.camionero || '', vendedor: query.vendedor || '', dia: query.dia || '' };
  let needsJoin = !!(filtros.vendedor || filtros.dia);
  let clause = '';
  const params = [];
  if (filtros.supervisor) { clause += ' AND v.supervisor = ?'; params.push(filtros.supervisor); }
  if (filtros.camionero) { clause += ' AND v.camionero = ?'; params.push(filtros.camionero); }
  if (filtros.vendedor) { clause += ' AND c.personal_comercial = ?'; params.push(filtros.vendedor); }
  if (filtros.dia) { clause += ' AND c.dias_visita = ?'; params.push(filtros.dia); }
  const join = needsJoin ? 'LEFT JOIN clientes c ON c.cliente_id = v.cliente_id' : '';
  return { clause, params, join };
}
 
// ---------- Opciones de filtros (para los desplegables) ----------
route('GET', '/api/filtros/opciones', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const supervisores = db.prepare(`SELECT DISTINCT supervisor FROM ventas WHERE supervisor IS NOT NULL AND supervisor != '' ORDER BY supervisor`).all().map(r => r.supervisor);
  const camioneros = db.prepare(`SELECT DISTINCT camionero FROM ventas WHERE camionero IS NOT NULL AND camionero != '' ORDER BY camionero`).all().map(r => r.camionero);
  const vendedores = db.prepare(`SELECT DISTINCT personal_comercial FROM clientes WHERE personal_comercial IS NOT NULL AND personal_comercial != '' ORDER BY personal_comercial`).all().map(r => r.personal_comercial);
  const dias = db.prepare(`SELECT DISTINCT dias_visita FROM clientes WHERE dias_visita IS NOT NULL AND dias_visita != '' ORDER BY dias_visita`).all().map(r => r.dias_visita);
  sendJson(res, 200, { supervisores, camioneros, vendedores, dias });
});
 
// ---------- KPIs por division (para la vista online) ----------
// GET /api/kpis?mes=8&anio=2026&supervisor=&camionero=&vendedor=&dia= - totales por categoria, comparacion interanual y proyeccion
route('GET', '/api/kpis', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  if (!mes || !anio) return sendJson(res, 400, { error: 'Faltan parametros mes y anio' });
  const { clause, params, join } = buildFiltros(parsed.query);
 
  const diasConfigRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('dias_configurados');
  const diasConfigurados = diasConfigRow ? Number(diasConfigRow.value) : null;
  const diasRealesRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(`dias_reales_${anio}_${String(mes).padStart(2, '0')}`);
  const diasReales = diasRealesRow ? Number(diasRealesRow.value) : null;
 
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const resultado = {};
  for (const cat of CATS) {
    const actualRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}`).get(cat, mes, anio, ...params);
    const anteriorRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}`).get(cat, mes, anio - 1, ...params);
    const actual = actualRow.total || 0;
    const anterior = anteriorRow.total || 0;
    const proyectado = (diasReales && diasConfigurados) ? (actual / diasReales * diasConfigurados) : null;
    const variacionPct = anterior > 0 ? ((actual - anterior) / anterior * 100) : null;
    resultado[cat] = {
      actual: Math.round(actual * 1000) / 1000,
      anio_anterior: Math.round(anterior * 1000) / 1000,
      proyectado: proyectado !== null ? Math.round(proyectado * 1000) / 1000 : null,
      variacion_pct: variacionPct !== null ? Math.round(variacionPct * 10) / 10 : null,
    };
  }
  sendJson(res, 200, {
    mes, anio,
    dias_configurados: diasConfigurados,
    dias_venta_reales: diasReales,
    categorias: resultado,
  });
});
route('GET', '/api/meta', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const rows = db.prepare('SELECT key, value FROM meta').all();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  sendJson(res, 200, out);
});
 
// ---------- Configuracion (dias del mes para proyeccion) ----------
// GET /api/config/dias - cualquiera logueado puede leerlo (para calcular proyecciones)
route('GET', '/api/config/dias', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('dias_configurados');
  sendJson(res, 200, { dias_configurados: row ? Number(row.value) : null });
});
// POST /api/config/dias - solo admin puede cambiarlo { dias: 22 }
route('POST', '/api/config/dias', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  const dias = Number(body.dias);
  if (!dias || dias <= 0 || dias > 31) return sendJson(res, 400, { error: 'Dias invalidos' });
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('dias_configurados', String(dias));
  sendJson(res, 200, { ok: true, dias_configurados: dias });
});
 
// ---------- Gestion de usuarios (solo admin) ----------
// GET /api/admin/users - listar usuarios (sin password)
route('GET', '/api/admin/users', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const rows = db.prepare('SELECT id, username, role FROM users ORDER BY role, username').all();
  sendJson(res, 200, rows);
});
// POST /api/admin/users - crear usuario nuevo { username, password, role }
route('POST', '/api/admin/users', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  const { username, password, role } = body;
  if (!username || !password || !role) {
    return sendJson(res, 400, { error: 'Faltan datos: username, password y role son obligatorios' });
  }
  if (!['admin', 'supervisor', 'vendedor'].includes(role)) {
    return sendJson(res, 400, { error: 'Rol invalido' });
  }
  if (authLib.findUserByUsername(username)) {
    return sendJson(res, 400, { error: 'Ese nombre de usuario ya existe' });
  }
  try {
    authLib.createUser(username, password, role);
  } catch (e) {
    return sendJson(res, 500, { error: 'Error creando usuario: ' + e.message });
  }
  sendJson(res, 200, { ok: true });
});
// DELETE /api/admin/users/:id - borrar usuario
route('DELETE', '/api/admin/users/:id', async (req, res, params) => {
  const session = requireAuth(req, res, ['admin']);
  if (!session) return;
  if (String(session.user_id) === String(params.id)) {
    return sendJson(res, 400, { error: 'No podes borrar tu propio usuario' });
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(params.id);
  sendJson(res, 200, { ok: true });
});
// POST /api/admin/users/:id/reset-password - resetear contraseña { password }
route('POST', '/api/admin/users/:id/reset-password', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  if (!body.password) return sendJson(res, 400, { error: 'Falta la nueva contraseña' });
  const { hash, salt } = authLib.hashPassword(body.password);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, params.id);
  sendJson(res, 200, { ok: true });
});
 
// ---------- Ranking de marcas y clientes (para la vista online) ----------
// GET /api/ranking/marcas?mes=&anio=&categoria=&supervisor=&camionero=&vendedor=&dia= - ranking de marcas de una categoria
route('GET', '/api/ranking/marcas', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  const categoria = parsed.query.categoria || '';
  if (!mes || !anio || !categoria) return sendJson(res, 400, { error: 'Faltan parametros mes, anio y categoria' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const rows = db.prepare(`
    SELECT v.marca as marca, SUM(v.um_hl) as hl FROM ventas v ${join}
    WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}
    GROUP BY v.marca HAVING SUM(v.um_hl) >= 0.001
    ORDER BY hl DESC
  `).all(categoria, mes, anio, ...params);
  sendJson(res, 200, rows.map(r => ({ marca: r.marca, hl: Math.round(r.hl * 1000) / 1000 })));
});
// GET /api/ranking/clientes?mes=&anio=&categoria=&marca=&supervisor=&camionero=&vendedor=&dia= - top 15 clientes de esa marca
route('GET', '/api/ranking/clientes', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  const categoria = parsed.query.categoria || '';
  const marca = parsed.query.marca || '';
  if (!mes || !anio || !categoria || !marca) return sendJson(res, 400, { error: 'Faltan parametros mes, anio, categoria y marca' });
  const filtros = buildFiltros(parsed.query);
  // Esta consulta siempre necesita el JOIN con clientes (para traer razon_social/domicilio), independientemente de los filtros.
  const rows = db.prepare(`
    SELECT v.cliente_id as cliente_id, c.razon_social as razon_social, c.domicilio as domicilio, SUM(v.um_hl) as hl
    FROM ventas v LEFT JOIN clientes c ON c.cliente_id = v.cliente_id
    WHERE v.categoria = ? AND v.marca = ? AND v.mes = ? AND v.anio = ?${filtros.clause}
    GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
    ORDER BY hl DESC LIMIT 15
  `).all(categoria, marca, mes, anio, ...filtros.params);
  sendJson(res, 200, rows.map(r => ({
    cliente_id: r.cliente_id,
    razon_social: r.razon_social || '',
    domicilio: r.domicilio || '',
    hl: Math.round(r.hl * 1000) / 1000,
  })));
});
 
// ---------- Referencia Vendedor-Supervisor (para que las subidas de ventas-solo no dependan de un archivo local) ----------
// GET /api/referencia/supervisores - cualquiera logueado puede leerla
route('GET', '/api/referencia/supervisores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('sup_ref_json');
  let mapping = {};
  if (row) { try { mapping = JSON.parse(row.value); } catch (e) { mapping = {}; } }
  sendJson(res, 200, { mapping });
});
// POST /api/referencia/supervisores - solo admin puede actualizarla { mapping: { "NORMALIZADO": "Supervisor" } }
route('POST', '/api/referencia/supervisores', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  if (!body.mapping || typeof body.mapping !== 'object') return sendJson(res, 400, { error: 'Falta mapping' });
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('sup_ref_json', JSON.stringify(body.mapping));
  sendJson(res, 200, { ok: true, cantidad: Object.keys(body.mapping).length });
});
 
// GET /api/ranking/clientes-categoria?mes=&anio=&categoria=&limit=&supervisor=&camionero=&vendedor=&dia= - top N clientes de TODA la categoria (todas las marcas sumadas)
route('GET', '/api/ranking/clientes-categoria', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  const categoria = parsed.query.categoria || '';
  const limit = Math.min(Number(parsed.query.limit) || 20, 100);
  if (!mes || !anio || !categoria) return sendJson(res, 400, { error: 'Faltan parametros mes, anio y categoria' });
  const filtros = buildFiltros(parsed.query);
  const rows = db.prepare(`
    SELECT v.cliente_id as cliente_id, c.razon_social as razon_social, c.domicilio as domicilio, SUM(v.um_hl) as hl
    FROM ventas v LEFT JOIN clientes c ON c.cliente_id = v.cliente_id
    WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${filtros.clause}
    GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
    ORDER BY hl DESC LIMIT ?
  `).all(categoria, mes, anio, ...filtros.params, limit);
  sendJson(res, 200, rows.map(r => ({
    cliente_id: r.cliente_id,
    razon_social: r.razon_social || '',
    domicilio: r.domicilio || '',
    hl: Math.round(r.hl * 1000) / 1000,
  })));
});
 
// GET /api/compradores?mes=&anio=&supervisor=&camionero=&vendedor=&dia= - cantidad de clientes distintos que compraron, por categoria
route('GET', '/api/compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  if (!mes || !anio) return sendJson(res, 400, { error: 'Faltan parametros mes y anio' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const resultado = {};
  for (const cat of CATS) {
    const rows = db.prepare(`
      SELECT v.cliente_id FROM ventas v ${join}
      WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}
      GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
    `).all(cat, mes, anio, ...params);
    resultado[cat] = rows.length;
  }
  // Total de compradores distintos (en cualquier categoria)
  const totalRows = db.prepare(`
    SELECT DISTINCT v.cliente_id FROM ventas v ${join}
    WHERE v.mes = ? AND v.anio = ?${clause}
  `).all(mes, anio, ...params);
  sendJson(res, 200, { categorias: resultado, total: totalRows.length });
});
 
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    const match = matchRoute(req.method, pathname);
    if (!match) return sendJson(res, 404, { error: 'Ruta no encontrada' });
    try {
      await match.handler(req, res, match.params);
    } catch (e) {
      console.error(e);
      sendJson(res, 500, { error: 'Error interno: ' + e.message });
    }
    return;
  }
  serveStatic(req, res, pathname);
});
(function autoSeed(){
  const count = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  if (count === 0) {
    authLib.createUser('surdorado', 'luca1901', 'admin');
    authLib.createUser('vendedores', 'vende2026', 'vendedor');
    console.log('Auto-seed: usuarios iniciales creados (surdorado / vendedores).');
  }
})();
server.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
module.exports = server;
