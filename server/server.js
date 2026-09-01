// server.js - Servidor HTTP principal
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db');
const authLib = require('./auth');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
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
      if (size > 200 * 1024 * 1024) {
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
function guardarVentas({ clientes, ventas, mes_actual, mes, anio, dias_venta_reales }) {
  if (!Array.isArray(clientes) || !Array.isArray(ventas)) {
    throw new Error('Formato invalido: se esperaba {clientes:[], ventas:[]}');
  }
  db.exec('BEGIN');
  try {
    if (mes && anio) {
      db.prepare('DELETE FROM ventas WHERE mes = ? AND anio = ?').run(Number(mes), Number(anio));
    } else {
      db.exec('DELETE FROM ventas');
    }
    const insCliente = db.prepare(`
      INSERT OR REPLACE INTO clientes (cliente_id, razon_social, domicilio, personal_comercial, dias_visita)
      VALUES (?,?,?,?,?)
    `);
    for (const c of clientes) {
      insCliente.run(String(c.cliente_id), c.razon_social || '', c.domicilio || '', c.personal_comercial || '', c.dias_visita || '');
    }
    const insVenta = db.prepare(`
      INSERT INTO ventas (cliente_id, categoria, marca, articulo, um_hl, supervisor, camionero, tipo_documento, mes, anio, canal) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const v of ventas) {
      insVenta.run(String(v.cliente_id), v.categoria, v.marca, v.articulo, Number(v.um_hl) || 0, v.supervisor || null, v.camionero || null, v.tipo_documento || null, v.mes || null, v.anio || null, v.canal || null);
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
    if (mes && anio) {
      const periodoActual = anio * 12 + mes;
      const periodoLimite = periodoActual - 13;
      const limiteAnio = Math.floor(periodoLimite / 12);
      const limiteMes = periodoLimite % 12;
      db.prepare('DELETE FROM ventas WHERE (anio * 12 + mes) <= ?').run(limiteAnio * 12 + limiteMes);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { clientes: clientes.length, ventas: ventas.length };
}
 
route('POST', '/api/upload', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  const raw = (await readBody(req)).toString('utf-8');
  let data;
  try { data = JSON.parse(raw); } catch (e) { return sendJson(res, 400, { error: 'JSON invalido' }); }
  let resultado;
  try {
    resultado = guardarVentas(data);
  } catch (e) {
    return sendJson(res, 500, { error: 'Error guardando datos: ' + e.message });
  }
  sendJson(res, 200, { ok: true, clientes: resultado.clientes, ventas: resultado.ventas });
});
 
const CAT_MAP_SERVIDOR = { 'CERVEZA': 'Cervezas', 'AGUA': 'Aguas', 'VINOS': 'Vinos', 'SIDRAS': 'Sidras' };
const normNameServidor = s => (s || '').toString().toUpperCase().trim().split(/\s+/).sort().join(' ');
function excelSerialToDate(n) {
  return new Date(Math.round((n - 25569) * 86400 * 1000));
}
function procesarExcelYGuardar(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: true });
  } catch (e) {
    throw { status: 400, error: 'No se pudo interpretar el archivo Excel: ' + e.message };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: undefined });
  if (!rows || rows.length < 2) throw { status: 400, error: 'El archivo de ventas está vacío o no se pudo leer.' };
 
  const header = rows[0];
  function findCol(name) {
    for (let i = 0; i < header.length; i++) { if (header[i] === name) return i; }
    return -1;
  }
  const idx = {
    division: findCol('Descripción DIVISION'),
    marca: findCol('Descripción MARCA'),
    cliente: findCol('Cliente'),
    vendedor: findCol('Descripcion Vendedor'),
    supervisor: findCol('Descripcion Supervisor'),
    impositivo: findCol('Impositivo'),
    um: findCol('UM Total'),
    anulado: findCol('Anulado'),
  };
  for (const k in idx) { if (idx[k] < 0) throw { status: 400, error: 'Falta la columna requerida: ' + k }; }
  const fechaIdx = findCol('Fecha Comprobante');
  const transpIdx = findCol('Descripcion Transporte');
  const articuloIdx = findCol('Descripcion de Articulo');
  const canalIdx = findCol('Descripcion Canal MKT');
 
  const supRefRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('sup_ref_json');
  let supRef = {};
  if (supRefRow) { try { supRef = JSON.parse(supRefRow.value); } catch (e) { supRef = {}; } }
  const FALLBACK = 'SIN ASIGNAR (no en tabla de referencia)';
 
  const vendAppAgg = new Map();
  const ventaDepositoVend = new Set();
  const fechaSet = new Set();
  const mesCount = {};
 
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const division = row[idx.division];
    const cat = CAT_MAP_SERVIDOR[division];
    if (!cat) continue;
    const anulado = row[idx.anulado];
    if (anulado && anulado !== 'NO') continue;
    const cliente = row[idx.cliente];
    const vendedor = row[idx.vendedor] || 'SIN VENDEDOR';
    const marca = row[idx.marca] || 'SIN MARCA';
    const um = row[idx.um] || 0;
    const fiscal = row[idx.impositivo] === 'SI' ? 1 : 0;
    const transp = (transpIdx >= 0 ? row[transpIdx] : null) || 'SIN TRANSPORTE';
    const canal = (canalIdx >= 0 ? row[canalIdx] : null) || 'SIN CANAL';
    const supRaw = row[idx.supervisor];
    if (!supRaw || String(supRaw).trim() === '') ventaDepositoVend.add(vendedor);
 
    if (fechaIdx >= 0) {
      const fRaw = row[fechaIdx];
      let dateObj = null;
      if (fRaw instanceof Date && !isNaN(fRaw)) dateObj = fRaw;
      else if (typeof fRaw === 'number' && fRaw > 0) dateObj = excelSerialToDate(fRaw);
      else if (typeof fRaw === 'string' && fRaw.trim()) { const p = new Date(fRaw); if (!isNaN(p)) dateObj = p; }
      if (dateObj && !isNaN(dateObj)) {
        const dstr = dateObj.getFullYear() + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + String(dateObj.getDate()).padStart(2, '0');
        fechaSet.add(dstr);
        const mkey = dateObj.getFullYear() + '-' + String(dateObj.getMonth() + 1).padStart(2, '0');
        mesCount[mkey] = (mesCount[mkey] || 0) + 1;
      }
    }
 
    if (articuloIdx >= 0 && cliente !== undefined && cliente !== null && cliente !== '') {
      const articulo = row[articuloIdx] || 'SIN ARTICULO';
      const vaKey = cliente + '|' + cat + '|' + marca + '|' + articulo + '|' + vendedor + '|' + transp + '|' + fiscal + '|' + canal;
      vendAppAgg.set(vaKey, (vendAppAgg.get(vaKey) || 0) + um);
    }
  }
 
  let mesActual = '', mesNumOut = null, anioNumOut = null;
  const bestMesEntry = Object.entries(mesCount).sort((a, b) => b[1] - a[1])[0];
  if (bestMesEntry) {
    const [y, m] = bestMesEntry[0].split('-').map(Number);
    const NOMBRES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    mesActual = NOMBRES[m - 1] + ' ' + y;
    mesNumOut = m; anioNumOut = y;
  }
 
  const ventas = [];
  for (const [vaKey, um] of vendAppAgg.entries()) {
    if (um < 0.001) continue;
    const [cliente_id, categoria, marca, articulo, vendedor, camionero, fiscalStr, canal] = vaKey.split('|');
    let supervisor;
    if (ventaDepositoVend.has(vendedor)) supervisor = 'VENTA DEPOSITO';
    else supervisor = supRef[normNameServidor(vendedor)] || FALLBACK;
    ventas.push({
      cliente_id, categoria, marca, articulo,
      um_hl: Math.round(um * 1000) / 1000,
      supervisor, camionero, canal,
      tipo_documento: fiscalStr === '1' ? 'FISCAL' : 'NO FISCAL',
      mes: mesNumOut, anio: anioNumOut,
    });
  }
 
  let resultado;
  try {
    resultado = guardarVentas({ clientes: [], ventas, mes_actual: mesActual, mes: mesNumOut, anio: anioNumOut, dias_venta_reales: fechaSet.size });
  } catch (e) {
    throw { status: 500, error: 'Error guardando datos: ' + e.message };
  }
  return { ok: true, mes_actual: mesActual, ventas: resultado.ventas };
}
 
// procesarExcelYGuardar (arriba) carga el archivo entero en memoria con la
// libreria xlsx: para archivos grandes (80MB+) eso hace que el proceso se
// quede sin memoria y crashee. Esta version usa el lector en streaming de
// ExcelJS, que lee el archivo fila por fila directo desde disco sin cargarlo
// entero en RAM, asi que el tamaño del archivo deja de importar.
function cellValStreaming(v) {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('result' in v) return v.result; // celda con formula
    if (Array.isArray(v.richText)) return v.richText.map(rt => rt.text).join(''); // texto con formato
    if ('text' in v) return v.text; // celda con hipervinculo
  }
  return v;
}
async function procesarExcelYGuardarStreaming(filePath) {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath);
 
  let idx = null;
  let fechaIdx = -1, transpIdx = -1, articuloIdx = -1, canalIdx = -1;
 
  const supRefRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('sup_ref_json');
  let supRef = {};
  if (supRefRow) { try { supRef = JSON.parse(supRefRow.value); } catch (e) { supRef = {}; } }
  const FALLBACK = 'SIN ASIGNAR (no en tabla de referencia)';
 
  const vendAppAgg = new Map();
  const ventaDepositoVend = new Set();
  const fechaSet = new Set();
  const mesCount = {};
 
  let huboHoja = false;
  for await (const worksheetReader of workbookReader) {
    if (huboHoja) break; // solo la primera hoja, igual que la version no-streaming
    huboHoja = true;
    for await (const row of worksheetReader) {
      const vals = row.values; // array 1-indexado (vals[0] no se usa)
      if (row.number === 1) {
        function findCol(name) {
          for (let i = 1; i < vals.length; i++) { if (cellValStreaming(vals[i]) === name) return i; }
          return -1;
        }
        idx = {
          division: findCol('Descripción DIVISION'),
          marca: findCol('Descripción MARCA'),
          cliente: findCol('Cliente'),
          vendedor: findCol('Descripcion Vendedor'),
          supervisor: findCol('Descripcion Supervisor'),
          impositivo: findCol('Impositivo'),
          um: findCol('UM Total'),
          anulado: findCol('Anulado'),
        };
        for (const k in idx) { if (idx[k] < 0) throw { status: 400, error: 'Falta la columna requerida: ' + k }; }
        fechaIdx = findCol('Fecha Comprobante');
        transpIdx = findCol('Descripcion Transporte');
        articuloIdx = findCol('Descripcion de Articulo');
        canalIdx = findCol('Descripcion Canal MKT');
        continue;
      }
      if (!idx) continue;
 
      const division = cellValStreaming(vals[idx.division]);
      const cat = CAT_MAP_SERVIDOR[division];
      if (!cat) continue;
      const anulado = cellValStreaming(vals[idx.anulado]);
      if (anulado && anulado !== 'NO') continue;
      const cliente = cellValStreaming(vals[idx.cliente]);
      const vendedor = cellValStreaming(vals[idx.vendedor]) || 'SIN VENDEDOR';
      const marca = cellValStreaming(vals[idx.marca]) || 'SIN MARCA';
      const um = cellValStreaming(vals[idx.um]) || 0;
      const fiscal = cellValStreaming(vals[idx.impositivo]) === 'SI' ? 1 : 0;
      const transp = (transpIdx >= 0 ? cellValStreaming(vals[transpIdx]) : null) || 'SIN TRANSPORTE';
      const canal = (canalIdx >= 0 ? cellValStreaming(vals[canalIdx]) : null) || 'SIN CANAL';
      const supRaw = cellValStreaming(vals[idx.supervisor]);
      if (!supRaw || String(supRaw).trim() === '') ventaDepositoVend.add(vendedor);
 
      if (fechaIdx >= 0) {
        const fRaw = cellValStreaming(vals[fechaIdx]);
        let dateObj = null;
        if (fRaw instanceof Date && !isNaN(fRaw)) dateObj = fRaw;
        else if (typeof fRaw === 'number' && fRaw > 0) dateObj = excelSerialToDate(fRaw);
        else if (typeof fRaw === 'string' && fRaw.trim()) { const p = new Date(fRaw); if (!isNaN(p)) dateObj = p; }
        if (dateObj && !isNaN(dateObj)) {
          const dstr = dateObj.getFullYear() + '-' + String(dateObj.getMonth() + 1).padStart(2, '0') + '-' + String(dateObj.getDate()).padStart(2, '0');
          fechaSet.add(dstr);
          const mkey = dateObj.getFullYear() + '-' + String(dateObj.getMonth() + 1).padStart(2, '0');
          mesCount[mkey] = (mesCount[mkey] || 0) + 1;
        }
      }
 
      if (articuloIdx >= 0 && cliente !== undefined && cliente !== null && cliente !== '') {
        const articulo = cellValStreaming(vals[articuloIdx]) || 'SIN ARTICULO';
        const vaKey = cliente + '|' + cat + '|' + marca + '|' + articulo + '|' + vendedor + '|' + transp + '|' + fiscal + '|' + canal;
        vendAppAgg.set(vaKey, (vendAppAgg.get(vaKey) || 0) + um);
      }
    }
  }
 
  if (!idx) throw { status: 400, error: 'El archivo de ventas está vacío o no se pudo leer.' };
 
  let mesActual = '', mesNumOut = null, anioNumOut = null;
  const bestMesEntry = Object.entries(mesCount).sort((a, b) => b[1] - a[1])[0];
  if (bestMesEntry) {
    const [y, m] = bestMesEntry[0].split('-').map(Number);
    const NOMBRES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    mesActual = NOMBRES[m - 1] + ' ' + y;
    mesNumOut = m; anioNumOut = y;
  }
 
  const ventas = [];
  for (const [vaKey, um] of vendAppAgg.entries()) {
    if (um < 0.001) continue;
    const [cliente_id, categoria, marca, articulo, vendedor, camionero, fiscalStr, canal] = vaKey.split('|');
    let supervisor;
    if (ventaDepositoVend.has(vendedor)) supervisor = 'VENTA DEPOSITO';
    else supervisor = supRef[normNameServidor(vendedor)] || FALLBACK;
    ventas.push({
      cliente_id, categoria, marca, articulo,
      um_hl: Math.round(um * 1000) / 1000,
      supervisor, camionero, canal,
      tipo_documento: fiscalStr === '1' ? 'FISCAL' : 'NO FISCAL',
      mes: mesNumOut, anio: anioNumOut,
    });
  }
 
  let resultado;
  try {
    resultado = guardarVentas({ clientes: [], ventas, mes_actual: mesActual, mes: mesNumOut, anio: anioNumOut, dias_venta_reales: fechaSet.size });
  } catch (e) {
    throw { status: 500, error: 'Error guardando datos: ' + e.message };
  }
  return { ok: true, mes_actual: mesActual, ventas: resultado.ventas };
}
 
route('POST', '/api/upload-excel', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  let buffer;
  try {
    buffer = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'No se pudo leer el archivo subido: ' + e.message });
  }
  try {
    const resultado = procesarExcelYGuardar(buffer);
    sendJson(res, 200, resultado);
  } catch (e) {
    sendJson(res, e.status || 500, { error: e.error || e.message || 'Error desconocido' });
  }
});
 
const DATA_DIR = process.env.DB_PATH ? path.dirname(process.env.DB_PATH) : path.join(__dirname, '..', 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp_uploads');
try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch (e) {}
 
function tmpPathFor(uploadId) {
  if (!/^[a-f0-9]{32}$/.test(uploadId)) return null;
  return path.join(TMP_DIR, uploadId + '.bin');
}
 
// Jobs de procesamiento en memoria: el archivo puede tardar mas que el timeout
// del proxy (Render u otro), asi que /finish responde enseguida y el frontend
// consulta el estado con /status en vez de esperar la respuesta del POST.
const uploadJobs = new Map();
 
route('POST', '/api/upload-excel/start', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  const uploadId = crypto.randomBytes(16).toString('hex');
  const filePath = tmpPathFor(uploadId);
  fs.writeFileSync(filePath, Buffer.alloc(0));
  sendJson(res, 200, { uploadId });
});
 
route('POST', '/api/upload-excel/chunk', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  const parsed = url.parse(req.url, true);
  const filePath = tmpPathFor(parsed.query.uploadId || '');
  if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 400, { error: 'uploadId invalido o expirado' });
  let chunk;
  try {
    chunk = await readBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: 'No se pudo leer el pedazo: ' + e.message });
  }
  fs.appendFileSync(filePath, chunk);
  sendJson(res, 200, { ok: true, size: fs.statSync(filePath).size });
});
 
route('POST', '/api/upload-excel/finish', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  const parsed = url.parse(req.url, true);
  const uploadId = parsed.query.uploadId || '';
  const filePath = tmpPathFor(uploadId);
  if (!filePath || !fs.existsSync(filePath)) return sendJson(res, 400, { error: 'uploadId invalido o expirado' });
 
  uploadJobs.set(uploadId, { status: 'procesando' });
  // Responder ya: procesarExcelYGuardar puede tardar varios minutos con
  // archivos grandes y superar el timeout del proxy, que devuelve HTML
  // en vez de JSON y rompe el .json() del frontend. El procesamiento
  // sigue despues de esta respuesta y el resultado se consulta por /status.
  sendJson(res, 202, { ok: true, uploadId, procesando: true });
 
  try {
    const resultado = await procesarExcelYGuardarStreaming(filePath);
    uploadJobs.set(uploadId, { status: 'listo', resultado });
  } catch (e) {
    uploadJobs.set(uploadId, { status: 'error', error: e.error || e.message || 'Error desconocido' });
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) {}
  }
});
 
route('GET', '/api/upload-excel/status', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  const parsed = url.parse(req.url, true);
  const uploadId = parsed.query.uploadId || '';
  const job = uploadJobs.get(uploadId);
  if (!job) return sendJson(res, 404, { error: 'uploadId invalido o expirado' });
  if (job.status === 'error') { uploadJobs.delete(uploadId); return sendJson(res, 500, { error: job.error }); }
  if (job.status === 'listo') { uploadJobs.delete(uploadId); return sendJson(res, 200, { status: 'listo', ...job.resultado }); }
  sendJson(res, 200, { status: 'procesando' });
});
 
// Cada filtro llega como valores separados por "|" (el frontend permite elegir
// mas de una opcion por filtro), por eso se arma un "IN (?,?,...)" en vez de
// una comparacion "=" simple. parseMulti separa y descarta vacios.
function parseMulti(v) {
  if (!v) return [];
  return String(v).split('|').map((s) => s.trim()).filter(Boolean);
}
function buildFiltros(query) {
  const filtros = {
    supervisor: parseMulti(query.supervisor),
    camionero: parseMulti(query.camionero),
    vendedor: parseMulti(query.vendedor),
    dia: parseMulti(query.dia),
  };
  let needsJoin = !!(filtros.vendedor.length || filtros.dia.length);
  let clause = '';
  const params = [];
  function addIn(campo, valores) {
    if (!valores.length) return;
    clause += ` AND ${campo} IN (${valores.map(() => '?').join(',')})`;
    params.push(...valores);
  }
  addIn('v.supervisor', filtros.supervisor);
  addIn('v.camionero', filtros.camionero);
  addIn('c.personal_comercial', filtros.vendedor);
  addIn('c.dias_visita', filtros.dia);
  const join = needsJoin ? 'LEFT JOIN clientes c ON c.cliente_id = v.cliente_id' : '';
  return { clause, params, join };
}
 
route('GET', '/api/filtros/opciones', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const supervisores = db.prepare(`SELECT DISTINCT supervisor FROM ventas WHERE supervisor IS NOT NULL AND supervisor != '' ORDER BY supervisor`).all().map(r => r.supervisor);
  const camioneros = db.prepare(`SELECT DISTINCT camionero FROM ventas WHERE camionero IS NOT NULL AND camionero != '' ORDER BY camionero`).all().map(r => r.camionero);
  const vendedores = db.prepare(`SELECT DISTINCT personal_comercial FROM clientes WHERE personal_comercial IS NOT NULL AND personal_comercial != '' ORDER BY personal_comercial`).all().map(r => r.personal_comercial);
  const dias = db.prepare(`SELECT DISTINCT dias_visita FROM clientes WHERE dias_visita IS NOT NULL AND dias_visita != '' ORDER BY dias_visita`).all().map(r => r.dias_visita);
  sendJson(res, 200, { supervisores, camioneros, vendedores, dias });
});
 
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
 
  let mesAnteriorNum = mes - 1, anioMesAnterior = anio;
  if (mesAnteriorNum < 1) { mesAnteriorNum = 12; anioMesAnterior = anio - 1; }
 
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const resultado = {};
  for (const cat of CATS) {
    const actualRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}`).get(cat, mes, anio, ...params);
    const anteriorRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}`).get(cat, mes, anio - 1, ...params);
    const mesAnteriorRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}`).get(cat, mesAnteriorNum, anioMesAnterior, ...params);
    const actual = actualRow.total || 0;
    const anterior = anteriorRow.total || 0;
    const mesAnterior = mesAnteriorRow.total || 0;
    const proyectado = (diasReales && diasConfigurados) ? (actual / diasReales * diasConfigurados) : null;
    const variacionPct = anterior > 0 ? ((actual - anterior) / anterior * 100) : null;
    const variacionMesPct = mesAnterior > 0 ? ((actual - mesAnterior) / mesAnterior * 100) : null;
    resultado[cat] = {
      actual: Math.round(actual * 1000) / 1000,
      anio_anterior: Math.round(anterior * 1000) / 1000,
      mes_anterior: Math.round(mesAnterior * 1000) / 1000,
      proyectado: proyectado !== null ? Math.round(proyectado * 1000) / 1000 : null,
      variacion_pct: variacionPct !== null ? Math.round(variacionPct * 10) / 10 : null,
      variacion_mes_pct: variacionMesPct !== null ? Math.round(variacionMesPct * 10) / 10 : null,
    };
  }
  sendJson(res, 200, {
    mes, anio,
    mes_anterior_num: mesAnteriorNum,
    anio_mes_anterior: anioMesAnterior,
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
 
route('GET', '/api/config/dias', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('dias_configurados');
  sendJson(res, 200, { dias_configurados: row ? Number(row.value) : null });
});
route('POST', '/api/config/dias', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  const dias = Number(body.dias);
  if (!dias || dias <= 0 || dias > 31) return sendJson(res, 400, { error: 'Dias invalidos' });
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('dias_configurados', String(dias));
  sendJson(res, 200, { ok: true, dias_configurados: dias });
});
 
route('GET', '/api/admin/users', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const rows = db.prepare('SELECT id, username, role FROM users ORDER BY role, username').all();
  sendJson(res, 200, rows);
});
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
route('POST', '/api/admin/users/:id/reset-password', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  if (!body.password) return sendJson(res, 400, { error: 'Falta la nueva contraseña' });
  const { hash, salt } = authLib.hashPassword(body.password);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, params.id);
  sendJson(res, 200, { ok: true });
});
 
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
route('GET', '/api/ranking/clientes', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  const categoria = parsed.query.categoria || '';
  const marca = parsed.query.marca || '';
  if (!mes || !anio || !categoria || !marca) return sendJson(res, 400, { error: 'Faltan parametros mes, anio, categoria y marca' });
  const filtros = buildFiltros(parsed.query);
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
 
route('GET', '/api/referencia/supervisores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('sup_ref_json');
  let mapping = {};
  if (row) { try { mapping = JSON.parse(row.value); } catch (e) { mapping = {}; } }
  sendJson(res, 200, { mapping });
  });
route('POST', '/api/referencia/supervisores', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  if (!body.mapping || typeof body.mapping !== 'object') return sendJson(res, 400, { error: 'Falta mapping' });
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('sup_ref_json', JSON.stringify(body.mapping));
  sendJson(res, 200, { ok: true, cantidad: Object.keys(body.mapping).length });
});
 
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
  const totalRows = db.prepare(`
    SELECT DISTINCT v.cliente_id FROM ventas v ${join}
    WHERE v.mes = ? AND v.anio = ?${clause}
  `).all(mes, anio, ...params);
  sendJson(res, 200, { categorias: resultado, total: totalRows.length });
});
 
function periodoMesAnterior(mes, anio) {
  let mesAnteriorNum = mes - 1, anioMesAnterior = anio;
  if (mesAnteriorNum < 1) { mesAnteriorNum = 12; anioMesAnterior = anio - 1; }
  return { mesAnteriorNum, anioMesAnterior };
}
 
route('GET', '/api/canal', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  if (!mes || !anio) return sendJson(res, 400, { error: 'Faltan parametros mes y anio' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const { mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(mes, anio);
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
 
  function volumenPorCanal(mesQ, anioQ) {
    const rows = db.prepare(`
      SELECT v.canal as canal, v.categoria as categoria, SUM(v.um_hl) as hl
      FROM ventas v ${join}
      WHERE v.mes = ? AND v.anio = ?${clause}
      GROUP BY v.canal, v.categoria
    `).all(mesQ, anioQ, ...params);
    const out = {};
    for (const r of rows) {
      const canal = r.canal || 'SIN CANAL';
      if (!out[canal]) out[canal] = {};
      out[canal][r.categoria] = r.hl || 0;
    }
    return out;
  }
 
  const actualData = volumenPorCanal(mes, anio);
  const anioAnteriorData = volumenPorCanal(mes, anio - 1);
  const mesAnteriorData = volumenPorCanal(mesAnteriorNum, anioMesAnterior);
  const canales = Array.from(new Set([
    ...Object.keys(actualData), ...Object.keys(anioAnteriorData), ...Object.keys(mesAnteriorData),
  ])).sort();
 
  const r3 = (n) => Math.round((n || 0) * 1000) / 1000;
  function armarFila(canal) {
    const categorias = {};
    let tA = 0, tAA = 0, tMA = 0;
    for (const cat of CATS) {
      const a = (actualData[canal] && actualData[canal][cat]) || 0;
      const aa = (anioAnteriorData[canal] && anioAnteriorData[canal][cat]) || 0;
      const ma = (mesAnteriorData[canal] && mesAnteriorData[canal][cat]) || 0;
      categorias[cat] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: r3(ma) };
      tA += a; tAA += aa; tMA += ma;
    }
    return { canal, categorias, total: { actual: r3(tA), anio_anterior: r3(tAA), mes_anterior: r3(tMA) } };
  }
 
  const filas = canales.map(armarFila);
  const totalGeneral = { categorias: {}, total: { actual: 0, anio_anterior: 0, mes_anterior: 0 } };
  for (const cat of CATS) {
    let a = 0, aa = 0, ma = 0;
    for (const f of filas) { a += f.categorias[cat].actual; aa += f.categorias[cat].anio_anterior; ma += f.categorias[cat].mes_anterior; }
    totalGeneral.categorias[cat] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: r3(ma) };
    totalGeneral.total.actual += a; totalGeneral.total.anio_anterior += aa; totalGeneral.total.mes_anterior += ma;
  }
  totalGeneral.total = { actual: r3(totalGeneral.total.actual), anio_anterior: r3(totalGeneral.total.anio_anterior), mes_anterior: r3(totalGeneral.total.mes_anterior) };
 
  sendJson(res, 200, {
    mes, anio, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    filas, total_general: totalGeneral,
  });
});
 
route('GET', '/api/canal-compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  if (!mes || !anio) return sendJson(res, 400, { error: 'Faltan parametros mes y anio' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const { mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(mes, anio);
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
 
  function compradoresPorCanal(mesQ, anioQ) {
    const rows = db.prepare(`
      SELECT canal, categoria, COUNT(*) as n FROM (
        SELECT v.canal as canal, v.categoria as categoria, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE v.mes = ? AND v.anio = ?${clause}
        GROUP BY v.canal, v.categoria, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY canal, categoria
    `).all(mesQ, anioQ, ...params);
    const porCat = {};
    for (const r of rows) {
      const canal = r.canal || 'SIN CANAL';
      if (!porCat[canal]) porCat[canal] = {};
      porCat[canal][r.categoria] = r.n;
    }
    const totalRows = db.prepare(`
      SELECT canal, COUNT(DISTINCT cliente_id) as n FROM ventas v ${join}
      WHERE v.mes = ? AND v.anio = ?${clause}
      GROUP BY v.canal
    `).all(mesQ, anioQ, ...params);
    const totales = {};
    for (const r of totalRows) totales[r.canal || 'SIN CANAL'] = r.n;
    return { porCat, totales };
  }
 
  function totalPorCategoria(mesQ, anioQ) {
    const rows = db.prepare(`
      SELECT categoria, COUNT(*) as n FROM (
        SELECT v.categoria as categoria, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE v.mes = ? AND v.anio = ?${clause}
        GROUP BY v.categoria, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY categoria
    `).all(mesQ, anioQ, ...params);
    const out = {};
    for (const r of rows) out[r.categoria] = r.n;
    return out;
  }
  function totalGeneralClientes(mesQ, anioQ) {
    const row = db.prepare(`SELECT COUNT(DISTINCT cliente_id) as n FROM ventas v ${join} WHERE v.mes = ? AND v.anio = ?${clause}`).get(mesQ, anioQ, ...params);
    return row.n || 0;
  }
 
  const actualData = compradoresPorCanal(mes, anio);
  const anioAnteriorData = compradoresPorCanal(mes, anio - 1);
  const mesAnteriorData = compradoresPorCanal(mesAnteriorNum, anioMesAnterior);
  const canales = Array.from(new Set([
    ...Object.keys(actualData.totales), ...Object.keys(anioAnteriorData.totales), ...Object.keys(mesAnteriorData.totales),
  ])).sort();
 
  function armarFila(canal) {
    const categorias = {};
    for (const cat of CATS) {
      categorias[cat] = {
        actual: (actualData.porCat[canal] && actualData.porCat[canal][cat]) || 0,
        anio_anterior: (anioAnteriorData.porCat[canal] && anioAnteriorData.porCat[canal][cat]) || 0,
        mes_anterior: (mesAnteriorData.porCat[canal] && mesAnteriorData.porCat[canal][cat]) || 0,
      };
    }
    return {
      canal, categorias,
      total: {
        actual: actualData.totales[canal] || 0,
        anio_anterior: anioAnteriorData.totales[canal] || 0,
        mes_anterior: mesAnteriorData.totales[canal] || 0,
      },
    };
  }
 
  const filas = canales.map(armarFila);
  const totalCatActual = totalPorCategoria(mes, anio);
  const totalCatAnioAnt = totalPorCategoria(mes, anio - 1);
  const totalCatMesAnt = totalPorCategoria(mesAnteriorNum, anioMesAnterior);
  const totalGeneral = {
    categorias: {},
    total: {
      actual: totalGeneralClientes(mes, anio),
      anio_anterior: totalGeneralClientes(mes, anio - 1),
      mes_anterior: totalGeneralClientes(mesAnteriorNum, anioMesAnterior),
    },
  };
  for (const cat of CATS) {
    totalGeneral.categorias[cat] = {
      actual: totalCatActual[cat] || 0,
      anio_anterior: totalCatAnioAnt[cat] || 0,
      mes_anterior: totalCatMesAnt[cat] || 0,
    };
  }
 
  sendJson(res, 200, {
    mes, anio, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    filas, total_general: totalGeneral,
  });
});
 
// Volumen (HL) por marca y canal, para UNA categoria a la vez (Cervezas, Aguas,
// Vinos o Sidras). Misma logica que /api/canal pero agrupando por v.marca en
// vez de v.categoria, y los "grupos" de columnas son los canales (dinamicos,
// se descubren con SELECT DISTINCT en vez de estar hardcodeados).
route('GET', '/api/marca-canal', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  const categoria = parsed.query.categoria || '';
  if (!mes || !anio || !categoria) return sendJson(res, 400, { error: 'Faltan parametros mes, anio y categoria' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const { mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(mes, anio);
 
  function volumenPorMarca(mesQ, anioQ) {
    const rows = db.prepare(`
      SELECT v.marca as marca, v.canal as canal, SUM(v.um_hl) as hl
      FROM ventas v ${join}
      WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}
      GROUP BY v.marca, v.canal
    `).all(categoria, mesQ, anioQ, ...params);
    const out = {};
    for (const r of rows) {
      const marca = r.marca || 'SIN MARCA';
      const canal = r.canal || 'SIN CANAL';
      if (!out[marca]) out[marca] = {};
      out[marca][canal] = r.hl || 0;
    }
    return out;
  }
 
  const actualData = volumenPorMarca(mes, anio);
  const anioAnteriorData = volumenPorMarca(mes, anio - 1);
  const mesAnteriorData = volumenPorMarca(mesAnteriorNum, anioMesAnterior);
  const marcas = Array.from(new Set([
    ...Object.keys(actualData), ...Object.keys(anioAnteriorData), ...Object.keys(mesAnteriorData),
  ])).sort();
  const canales = Array.from(new Set([
    ...Object.values(actualData).flatMap(o => Object.keys(o)),
    ...Object.values(anioAnteriorData).flatMap(o => Object.keys(o)),
    ...Object.values(mesAnteriorData).flatMap(o => Object.keys(o)),
  ])).sort();
 
  const r3 = (n) => Math.round((n || 0) * 1000) / 1000;
  function armarFila(marca) {
    const porGrupo = {};
    let tA = 0, tAA = 0, tMA = 0;
    for (const canal of canales) {
      const a = (actualData[marca] && actualData[marca][canal]) || 0;
      const aa = (anioAnteriorData[marca] && anioAnteriorData[marca][canal]) || 0;
      const ma = (mesAnteriorData[marca] && mesAnteriorData[marca][canal]) || 0;
      porGrupo[canal] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: r3(ma) };
      tA += a; tAA += aa; tMA += ma;
    }
    return { nombre: marca, porGrupo, total: { actual: r3(tA), anio_anterior: r3(tAA), mes_anterior: r3(tMA) } };
  }
 
  const filas = marcas.map(armarFila).sort((a, b) => b.total.actual - a.total.actual);
  const totalGeneral = { porGrupo: {}, total: { actual: 0, anio_anterior: 0, mes_anterior: 0 } };
  for (const canal of canales) {
    let a = 0, aa = 0, ma = 0;
    for (const f of filas) { a += f.porGrupo[canal].actual; aa += f.porGrupo[canal].anio_anterior; ma += f.porGrupo[canal].mes_anterior; }
    totalGeneral.porGrupo[canal] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: r3(ma) };
    totalGeneral.total.actual += a; totalGeneral.total.anio_anterior += aa; totalGeneral.total.mes_anterior += ma;
  }
  totalGeneral.total = { actual: r3(totalGeneral.total.actual), anio_anterior: r3(totalGeneral.total.anio_anterior), mes_anterior: r3(totalGeneral.total.mes_anterior) };
 
  sendJson(res, 200, {
    mes, anio, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    grupos: canales, filas, total_general: totalGeneral,
  });
});
 
// Compradores (clientes distintos) por marca y canal, para UNA categoria a la
// vez. Misma idea que /api/marca-canal pero contando clientes en vez de sumar HL.
route('GET', '/api/marca-canal-compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const mes = Number(parsed.query.mes);
  const anio = Number(parsed.query.anio);
  const categoria = parsed.query.categoria || '';
  if (!mes || !anio || !categoria) return sendJson(res, 400, { error: 'Faltan parametros mes, anio y categoria' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const { mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(mes, anio);
 
  function compradoresPorMarca(mesQ, anioQ) {
    const rows = db.prepare(`
      SELECT marca, canal, COUNT(*) as n FROM (
        SELECT v.marca as marca, v.canal as canal, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}
        GROUP BY v.marca, v.canal, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY marca, canal
    `).all(categoria, mesQ, anioQ, ...params);
    const out = {};
    for (const r of rows) {
      const marca = r.marca || 'SIN MARCA';
      const canal = r.canal || 'SIN CANAL';
      if (!out[marca]) out[marca] = {};
      out[marca][canal] = r.n;
    }
    return out;
  }
 
  const actualData = compradoresPorMarca(mes, anio);
  const anioAnteriorData = compradoresPorMarca(mes, anio - 1);
  const mesAnteriorData = compradoresPorMarca(mesAnteriorNum, anioMesAnterior);
  const marcas = Array.from(new Set([
    ...Object.keys(actualData), ...Object.keys(anioAnteriorData), ...Object.keys(mesAnteriorData),
  ])).sort();
  const canales = Array.from(new Set([
    ...Object.values(actualData).flatMap(o => Object.keys(o)),
    ...Object.values(anioAnteriorData).flatMap(o => Object.keys(o)),
    ...Object.values(mesAnteriorData).flatMap(o => Object.keys(o)),
  ])).sort();
 
  function armarFila(marca) {
    const porGrupo = {};
    for (const canal of canales) {
      porGrupo[canal] = {
        actual: (actualData[marca] && actualData[marca][canal]) || 0,
        anio_anterior: (anioAnteriorData[marca] && anioAnteriorData[marca][canal]) || 0,
        mes_anterior: (mesAnteriorData[marca] && mesAnteriorData[marca][canal]) || 0,
      };
    }
    let tA = 0, tAA = 0, tMA = 0;
    for (const canal of canales) { tA += porGrupo[canal].actual; tAA += porGrupo[canal].anio_anterior; tMA += porGrupo[canal].mes_anterior; }
    return { nombre: marca, porGrupo, total: { actual: tA, anio_anterior: tAA, mes_anterior: tMA } };
  }
 
  const filas = marcas.map(armarFila).sort((a, b) => b.total.actual - a.total.actual);
  const totalGeneral = { porGrupo: {}, total: { actual: 0, anio_anterior: 0, mes_anterior: 0 } };
  for (const canal of canales) {
    let a = 0, aa = 0, ma = 0;
    for (const f of filas) { a += f.porGrupo[canal].actual; aa += f.porGrupo[canal].anio_anterior; ma += f.porGrupo[canal].mes_anterior; }
    totalGeneral.porGrupo[canal] = { actual: a, anio_anterior: aa, mes_anterior: ma };
    totalGeneral.total.actual += a; totalGeneral.total.anio_anterior += aa; totalGeneral.total.mes_anterior += ma;
  }
 
  sendJson(res, 200, {
    mes, anio, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    grupos: canales, filas, total_general: totalGeneral,
  });
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
