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
// La app de vendedores siempre muestra el "mes en curso" (el ultimo periodo
// cargado via upload, guardado en meta.mes_actual_num/anio_actual_num) - no
// el historico completo de ventas. Si todavia no se cargo ningun archivo no
// hay periodo definido y se muestra todo (comportamiento anterior).
function getPeriodoActual() {
  const mesRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('mes_actual_num');
  const anioRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('anio_actual_num');
  return {
    mes: mesRow ? Number(mesRow.value) : null,
    anio: anioRow ? Number(anioRow.value) : null,
  };
}
function periodoClauseFor(alias, mes, anio) {
  if (!mes || !anio) return '';
  const col = alias ? alias + '.' : '';
  return ` AND ${col}mes = ? AND ${col}anio = ?`;
}
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
  const { mes, anio } = getPeriodoActual();
  const periodoClause = periodoClauseFor('v', mes, anio);
  const periodoParams = (mes && anio) ? [mes, anio] : [];
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const compradoresPorCat = {};
  for (const cat of CATS) {
    const rows = db.prepare(`
      SELECT DISTINCT v.cliente_id FROM ventas v
      JOIN clientes c ON c.cliente_id = v.cliente_id
      WHERE c.personal_comercial = ? AND c.dias_visita = ? AND v.categoria = ?${periodoClause}
      GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
    `).all(vendedor, dia, cat, ...periodoParams);
    compradoresPorCat[cat] = rows.length;
  }
  sendJson(res, 200, {
    total_clientes: clientes.length,
    compradores_por_categoria: compradoresPorCat,
    clientes,
  });
});
route('GET', '/api/clientes/categoria', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const vendedor = parsed.query.vendedor || '';
  const dia = parsed.query.dia || '';
  const categoria = parsed.query.categoria || '';
  const { mes, anio } = getPeriodoActual();
  const periodoClauseV = periodoClauseFor('v', mes, anio);
  const periodoClausePlain = periodoClauseFor(null, mes, anio);
  const periodoParams = (mes && anio) ? [mes, anio] : [];
  const rows = db.prepare(`
    SELECT c.cliente_id, c.razon_social, c.domicilio FROM clientes c
    JOIN ventas v ON v.cliente_id = c.cliente_id
    WHERE c.personal_comercial = ? AND c.dias_visita = ? AND v.categoria = ?${periodoClauseV}
    GROUP BY c.cliente_id HAVING SUM(v.um_hl) >= 0.001
    ORDER BY c.razon_social
  `).all(vendedor, dia, categoria, ...periodoParams);
  // Para el dibujito: todas las categorias que compro cada cliente en el
  // mismo periodo (no solo la que se esta mirando).
  const catStmt = db.prepare(`
    SELECT categoria FROM ventas
    WHERE cliente_id = ?${periodoClausePlain}
    GROUP BY categoria HAVING SUM(um_hl) >= 0.001
  `);
  const out = rows.map(r => ({
    cliente_id: r.cliente_id,
    razon_social: r.razon_social,
    domicilio: r.domicilio,
    categorias: catStmt.all(r.cliente_id, ...periodoParams).map(x => x.categoria),
  }));
  sendJson(res, 200, out);
});
route('GET', '/api/cliente/:id', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const cliente = db.prepare('SELECT * FROM clientes WHERE cliente_id = ?').get(params.id);
  if (!cliente) return sendJson(res, 404, { error: 'Cliente no encontrado' });
  const { mes, anio } = getPeriodoActual();
  const periodoClause = periodoClauseFor(null, mes, anio);
  const periodoParams = (mes && anio) ? [mes, anio] : [];
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const resultado = {};
  for (const cat of CATS) {
    const rows = db.prepare(`
      SELECT marca, SUM(um_hl) as hl FROM ventas
      WHERE cliente_id = ? AND categoria = ?${periodoClause}
      GROUP BY marca HAVING SUM(um_hl) >= 0.001
      ORDER BY hl DESC
    `).all(params.id, cat, ...periodoParams);
    resultado[cat] = rows;
  }
  sendJson(res, 200, { cliente, compras: resultado });
});
route('GET', '/api/cliente/:id/marca/:marca', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const { mes, anio } = getPeriodoActual();
  const periodoClause = periodoClauseFor(null, mes, anio);
  const periodoParams = (mes && anio) ? [mes, anio] : [];
  const rows = db.prepare(`
    SELECT articulo, SUM(um_hl) as hl FROM ventas
    WHERE cliente_id = ? AND marca = ?${periodoClause}
    GROUP BY articulo HAVING SUM(um_hl) >= 0.001
    ORDER BY hl DESC
  `).all(params.id, params.marca, ...periodoParams);
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
// Logica de agregacion compartida entre procesarExcelYGuardar (SheetJS, en
// memoria - usado por /api/upload-excel directo) y
// procesarExcelYGuardarStreaming (exceljs streaming - usado por
// /api/upload-excel/finish, ver mas abajo por que). agregarFilaVenta recibe
// los valores crudos de UNA fila y los acumula; finalizarYGuardar cierra el
// proceso.
function nuevoAcumuladorVentas() {
  const supRefRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('sup_ref_json');
  let supRef = {};
  if (supRefRow) { try { supRef = JSON.parse(supRefRow.value); } catch (e) { supRef = {}; } }
  return {
    supRef,
    FALLBACK: 'SIN ASIGNAR (no en tabla de referencia)',
    vendAppAgg: new Map(),
    ventaDepositoVend: new Set(),
    fechaSet: new Set(),
    mesCount: {},
  };
}
function fechaAStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function agregarFilaVenta(acc, f) {
  const cat = CAT_MAP_SERVIDOR[f.division];
  if (!cat) return;
  if (f.anulado && f.anulado !== 'NO') return;
  const vendedor = f.vendedor || 'SIN VENDEDOR';
  const marca = f.marca || 'SIN MARCA';
  const um = f.um || 0;
  const fiscal = f.impositivo === 'SI' ? 1 : 0;
  const transp = f.transporte || 'SIN TRANSPORTE';
  const canal = f.canal || 'SIN CANAL';
  if (!f.supervisor || String(f.supervisor).trim() === '') acc.ventaDepositoVend.add(vendedor);

  let dstr = null;
  const fRaw = f.fecha;
  if (fRaw instanceof Date && !isNaN(fRaw)) dstr = fechaAStr(fRaw);
  else if (typeof fRaw === 'number' && fRaw > 0) dstr = fechaAStr(excelSerialToDate(fRaw));
  else if (typeof fRaw === 'string' && fRaw.trim()) {
    // "YYYY-MM-DD": ya viene normalizada (filas extraidas en el navegador)
    if (/^\d{4}-\d{2}-\d{2}$/.test(fRaw.trim())) dstr = fRaw.trim();
    else { const p = new Date(fRaw); if (!isNaN(p)) dstr = fechaAStr(p); }
  }
  if (dstr) {
    acc.fechaSet.add(dstr);
    const mkey = dstr.slice(0, 7);
    acc.mesCount[mkey] = (acc.mesCount[mkey] || 0) + 1;
  }

  if (f.cliente !== undefined && f.cliente !== null && f.cliente !== '') {
    const articulo = f.articulo || 'SIN ARTICULO';
    const vaKey = f.cliente + '|' + cat + '|' + marca + '|' + articulo + '|' + vendedor + '|' + transp + '|' + fiscal + '|' + canal;
    acc.vendAppAgg.set(vaKey, (acc.vendAppAgg.get(vaKey) || 0) + um);
  }
}
function finalizarYGuardar(acc) {
  let mesActual = '', mesNumOut = null, anioNumOut = null;
  const bestMesEntry = Object.entries(acc.mesCount).sort((a, b) => b[1] - a[1])[0];
  if (bestMesEntry) {
    const [y, m] = bestMesEntry[0].split('-').map(Number);
    const NOMBRES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    mesActual = NOMBRES[m - 1] + ' ' + y;
    mesNumOut = m; anioNumOut = y;
  }

  const ventas = [];
  for (const [vaKey, um] of acc.vendAppAgg.entries()) {
    if (um < 0.001) continue;
    const [cliente_id, categoria, marca, articulo, vendedor, camionero, fiscalStr, canal] = vaKey.split('|');
    let supervisor;
    if (acc.ventaDepositoVend.has(vendedor)) supervisor = 'VENTA DEPOSITO';
    else supervisor = acc.supRef[normNameServidor(vendedor)] || acc.FALLBACK;
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
    resultado = guardarVentas({ clientes: [], ventas, mes_actual: mesActual, mes: mesNumOut, anio: anioNumOut, dias_venta_reales: acc.fechaSet.size });
  } catch (e) {
    throw { status: 500, error: 'Error guardando datos: ' + e.message };
  }
  return { ok: true, mes_actual: mesActual, ventas: resultado.ventas };
}

// Nota sobre memoria: el archivo de ventas tiene ~260 columnas pero solo se
// necesitan ~12. Se lee directo de la estructura densa de la libreria
// (ws['!data']) y solo se toman los valores de las columnas que hacen
// falta, fila por fila, sin duplicar el resto en un array aparte.
function procesarExcelYGuardar(buffer) {
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, dense: true });
  } catch (e) {
    throw { status: 400, error: 'No se pudo interpretar el archivo Excel: ' + e.message };
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws || !ws['!ref'] || !ws['!data']) throw { status: 400, error: 'El archivo de ventas está vacío o no se pudo leer.' };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const data = ws['!data'];
  function cellVal(r, c) {
    const row = data[r];
    const cell = row ? row[c] : undefined;
    return cell ? cell.v : undefined;
  }

  const header = [];
  for (let c = range.s.c; c <= range.e.c; c++) header.push(cellVal(range.s.r, c));
  // findCol devuelve el numero de columna real (para usar con cellVal), no
  // la posicion dentro de "header" - por eso se suma range.s.c.
  function findCol(name) {
    for (let i = 0; i < header.length; i++) { if (header[i] === name) return i + range.s.c; }
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

  const acc = nuevoAcumuladorVentas();
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    if (!data[r]) continue;
    agregarFilaVenta(acc, {
      division: cellVal(r, idx.division),
      marca: cellVal(r, idx.marca),
      cliente: cellVal(r, idx.cliente),
      vendedor: cellVal(r, idx.vendedor),
      supervisor: cellVal(r, idx.supervisor),
      impositivo: cellVal(r, idx.impositivo),
      um: cellVal(r, idx.um),
      anulado: cellVal(r, idx.anulado),
      fecha: fechaIdx >= 0 ? cellVal(r, fechaIdx) : null,
      transporte: transpIdx >= 0 ? cellVal(r, transpIdx) : null,
      articulo: articuloIdx >= 0 ? cellVal(r, articuloIdx) : null,
      canal: canalIdx >= 0 ? cellVal(r, canalIdx) : null,
    });
  }
  return finalizarYGuardar(acc);
}

// El archivo de ventas real pesa 15-25MB con ~260 columnas y hasta ~100.000
// filas. Se probo primero parsearlo en el navegador con la misma libreria
// que usa /api/upload-excel (xlsx/SheetJS), quedandose solo con las ~12
// columnas que hacen falta, para no tener que subir el binario pesado. Pero
// esa libreria arma el libro ENTERO en memoria antes de devolver nada, y con
// este volumen terminaba "perdiendo" todas las celdas (el archivo se leia
// como vacio) - paso tanto con el .xlsb original como con una copia
// guardada de nuevo en Excel como .xlsx, asi que no era un problema del
// formato del archivo sino del volumen de datos.
// La solucion real es parsear en modo streaming: exceljs (WorkbookReader)
// lee el archivo fila por fila SIN cargar el libro completo en memoria, asi
// que el tamaño del archivo no importa. Por eso el archivo se vuelve a subir
// crudo (ver procesarVentasHoy en visor.html) y se parsea aca.
// exceljs no puede leer .xlsb (formato binario propietario de Microsoft, sin
// XML adentro) - si el nombre del archivo termina en .xlsb se avisa antes de
// intentar leerlo para no dar un error confuso.
const COLUMNAS_VENTAS_REQUERIDAS = ['Descripción DIVISION', 'Descripción MARCA', 'Cliente', 'Descripcion Vendedor', 'Descripcion Supervisor', 'Impositivo', 'UM Total', 'Anulado'];
const COLUMNAS_VENTAS_OPCIONALES = ['Fecha Comprobante', 'Descripcion Transporte', 'Descripcion de Articulo', 'Descripcion Canal MKT'];

function cellValStreaming(v) {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((rt) => rt.text).join('');
    if (v.result !== undefined) return v.result;
    if (v.text !== undefined) return v.text;
    return undefined;
  }
  return v;
}

async function procesarExcelYGuardarStreaming(filePath, nombreOriginal) {
  if (nombreOriginal && /\.xlsb$/i.test(nombreOriginal)) {
    throw { status: 400, error: 'Los archivos .xlsb no se pueden leer directamente. Abrilo en Excel, hace "Archivo > Guardar como > Libro de Excel (.xlsx)" y subi ese archivo.' };
  }

  const acc = nuevoAcumuladorVentas();
  const idx = {};
  let headerLeida = false;
  let filasLeidas = 0;

  let workbookReader;
  try {
    workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});
    for await (const worksheetReader of workbookReader) {
      for await (const row of worksheetReader) {
        const vals = row.values;
        if (!headerLeida) {
          headerLeida = true;
          for (let c = 1; c < vals.length; c++) {
            const nombre = cellValStreaming(vals[c]);
            if (COLUMNAS_VENTAS_REQUERIDAS.includes(nombre) || COLUMNAS_VENTAS_OPCIONALES.includes(nombre)) idx[nombre] = c;
          }
          for (const nombre of COLUMNAS_VENTAS_REQUERIDAS) {
            if (idx[nombre] === undefined) throw { status: 400, error: 'Falta la columna requerida: ' + nombre };
          }
          continue;
        }
        const division = cellValStreaming(vals[idx['Descripción DIVISION']]);
        if (division === undefined) continue;
        filasLeidas++;
        agregarFilaVenta(acc, {
          division,
          marca: cellValStreaming(vals[idx['Descripción MARCA']]),
          cliente: cellValStreaming(vals[idx['Cliente']]),
          vendedor: cellValStreaming(vals[idx['Descripcion Vendedor']]),
          supervisor: cellValStreaming(vals[idx['Descripcion Supervisor']]),
          impositivo: cellValStreaming(vals[idx['Impositivo']]),
          um: cellValStreaming(vals[idx['UM Total']]),
          anulado: cellValStreaming(vals[idx['Anulado']]),
          fecha: idx['Fecha Comprobante'] !== undefined ? cellValStreaming(vals[idx['Fecha Comprobante']]) : null,
          transporte: idx['Descripcion Transporte'] !== undefined ? cellValStreaming(vals[idx['Descripcion Transporte']]) : null,
          articulo: idx['Descripcion de Articulo'] !== undefined ? cellValStreaming(vals[idx['Descripcion de Articulo']]) : null,
          canal: idx['Descripcion Canal MKT'] !== undefined ? cellValStreaming(vals[idx['Descripcion Canal MKT']]) : null,
        });
      }
      break; // solo se procesa la primera hoja
    }
  } catch (e) {
    if (e && e.status) throw e;
    const msg = (e && e.message) ? e.message : String(e);
    // Bug conocido de exceljs (streaming): a veces, con la lectura por
    // partes del zip, el bloque que dice cuantas hojas tiene el libro
    // llega "tarde" y esto tira este error puntual - no es un archivo
    // realmente corrupto. Suele funcionar si se sube de nuevo.
    if (/reading '?sheets'?/i.test(msg)) {
      throw { status: 400, error: 'Error interno al leer el archivo (problema conocido de la librería con archivos grandes). Probá subirlo de nuevo; si vuelve a pasar, avisale a tu desarrollador.' };
    }
    throw { status: 400, error: 'No se pudo interpretar el archivo Excel: ' + msg };
  }

  if (!headerLeida) throw { status: 400, error: 'El archivo está vacío o no se pudo leer (no se encontró ninguna fila).' };
  if (filasLeidas === 0) throw { status: 400, error: 'El archivo no tiene filas de ventas para las categorías conocidas.' };
  return finalizarYGuardar(acc);
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
// Nombre original del archivo (lo manda el navegador en /start): sirve para
// avisar temprano si es un .xlsb, que exceljs no puede leer.
const uploadFilenames = new Map();

route('POST', '/api/upload-excel/start', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor']);
  if (!session) return;
  const parsed = url.parse(req.url, true);
  const filename = (parsed.query.filename || '').toString();
  if (/\.xlsb$/i.test(filename)) {
    return sendJson(res, 400, { error: 'Los archivos .xlsb no se pueden leer directamente. Abrilo en Excel, hace "Archivo > Guardar como > Libro de Excel (.xlsx)" y subi ese archivo.' });
  }
  const uploadId = crypto.randomBytes(16).toString('hex');
  const filePath = tmpPathFor(uploadId);
  fs.writeFileSync(filePath, Buffer.alloc(0));
  if (filename) uploadFilenames.set(uploadId, filename);
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
    const resultado = await procesarExcelYGuardarStreaming(filePath, uploadFilenames.get(uploadId));
    uploadJobs.set(uploadId, { status: 'listo', resultado });
  } catch (e) {
    uploadJobs.set(uploadId, { status: 'error', error: e.error || e.message || 'Error desconocido' });
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) {}
    uploadFilenames.delete(uploadId);
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
