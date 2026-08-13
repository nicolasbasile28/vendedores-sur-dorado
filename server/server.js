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
      if (size > 60 * 1024 * 1024) { // 60MB limite
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
  const session = requireAuth(req, res, ['admin']);
  if (!session) return;
  const raw = (await readBody(req)).toString('utf-8');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'JSON invalido' }); }
  const { clientes, ventas, mes_actual } = data;
  if (!Array.isArray(clientes) || !Array.isArray(ventas)) {
    return sendJson(res, 400, { error: 'Formato invalido: se esperaba {clientes:[], ventas:[]}' });
  }
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM ventas');
    db.exec('DELETE FROM clientes');
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
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return sendJson(res, 500, { error: 'Error guardando datos: ' + e.message });
  }
  sendJson(res, 200, { ok: true,
