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

// Normaliza texto de dia: separa combinados tipo "LUJU" no hace falta,
// el campo dias_visita ya viene tal cual del Universo (ej: 'LUNES', 'LUJU', 'MAVI', 'MISA').
// Un vendedor puede tener clientes con distintos codigos de dia; el desplegable de dias
// se arma con los codigos distintos que existan para ESE vendedor.

// ---------- Rutas API ----------
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

// POST /api/login
route('POST', '/api/login', async (req, res) => {
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  const result = authLib.login(body.username || '', body.password || '');
  if (!result) return sendJson(res, 401, { error: 'Usuario o contraseña incorrectos' });
  sendJson(res, 200, result);
});

// POST /api/logout
route('POST', '/api/logout', async (req, res) => {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) authLib.logout(token);
  sendJson(res, 200, { ok: true });
});

// GET /api/vendedores - lista de nombres distintos (personal_comercial)
route('GET', '/api/vendedores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const rows = db.prepare(`
    SELECT DISTINCT personal_comercial FROM clientes
    WHERE personal_comercial IS NOT NULL AND personal_comercial != ''
    ORDER BY personal_comercial
  `).all();
  sendJson(res, 200, rows.map(r => r.personal_comercial));
});

// GET /api/dias?vendedor=X - dias distintos para ese vendedor
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

// GET /api/clientes?vendedor=X&dia=Y - lista de clientes + resumen de compras por categoria
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

// GET /api/cliente/:id - detalle: categorias + marcas con HL
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

// GET /api/cliente/:id/marca/:marca - articulos comprados de esa marca
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

// POST /api/upload - admin sube datos ya procesados (JSON) desde el navegador
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
    const insVenta = const insVenta = const insVenta = db.prepare(`
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

  sendJson(res, 200, { ok: true, clientes: clientes.length, ventas: ventas.length });
});

// GET /api/meta
route('GET', '/api/meta', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const rows = db.prepare('SELECT key, value FROM meta').all();
  const out = {};
  rows.forEach(r => out[r.key] = r.value);
  sendJson(res, 200, out);
});

// ---------- Archivos estaticos ----------
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
      // SPA fallback -> index.html
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

// ---------- Servidor ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
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

// Auto-seed: si no hay ningun usuario todavia, crea el admin y el vendedor por defecto.
// Esto reemplaza la necesidad de correr "npm run seed" a mano (util en el plan gratuito
// de Render, que no tiene consola/Shell disponible).
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
