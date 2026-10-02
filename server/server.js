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
// Venta de estos 3 camioneros ("Descripcion Transporte" en el Excel, guardado
// en ventas.camionero) es venta "por afuera" que no le entra al variable de
// los vendedores - a pedido del usuario, esa venta tiene que dejar de existir
// SOLO en la app de vendedores (compradores, HL, cobertura). El dashboard de
// admin/supervisor (visor.html) sigue mostrando el total real, incluida esta
// venta - por eso este filtro NO se toca en ninguna ruta de visor.html.
const CAMIONEROS_EXCLUIDOS_APP = ['DIAZ LEANDRO PABLO', 'MASTROVITO LUIS DIEGO', 'RUIZ LUCAS GONZALO'];
function camioneroExcluidoClause(alias) {
  const col = alias ? alias + '.' : '';
  return ` AND UPPER(TRIM(${col}camionero)) NOT IN (${CAMIONEROS_EXCLUIDOS_APP.map(() => '?').join(',')})`;
}
route('GET', '/api/clientes', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const vendedor = parsed.query.vendedor || '';
  const dia = parsed.query.dia || '';
  const clientes = db.prepare(`
    SELECT cliente_id, razon_social, domicilio, horario_entrega FROM clientes
    WHERE personal_comercial = ? AND dias_visita = ?
    ORDER BY razon_social
  `).all(vendedor, dia);
  const { mes, anio } = getPeriodoActual();
  const periodoClause = periodoClauseFor('v', mes, anio) + camioneroExcluidoClause('v');
  const periodoParams = (mes && anio) ? [mes, anio, ...CAMIONEROS_EXCLUIDOS_APP] : [...CAMIONEROS_EXCLUIDOS_APP];
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
  // Categorias compradas por cada cliente (para el dibujito del lado
  // derecho en el listado principal): una sola consulta agrupada en vez de
  // una por cliente.
  const catPorClienteRows = db.prepare(`
    SELECT v.cliente_id as cliente_id, v.categoria as categoria FROM ventas v
    JOIN clientes c ON c.cliente_id = v.cliente_id
    WHERE c.personal_comercial = ? AND c.dias_visita = ?${periodoClause}
    GROUP BY v.cliente_id, v.categoria HAVING SUM(v.um_hl) >= 0.001
  `).all(vendedor, dia, ...periodoParams);
  const catPorCliente = {};
  for (const r of catPorClienteRows) {
    if (!catPorCliente[r.cliente_id]) catPorCliente[r.cliente_id] = [];
    catPorCliente[r.cliente_id].push(r.categoria);
  }
  // "Isotonicas" no es una division propia del Excel de ventas: es la marca
  // FULL SPORT dentro de la division Aguas. A pedido del usuario, NO se
  // trata como una categoria mas (no aparece desglosada en el detalle del
  // cliente) - solo se calcula este flag para mostrar el iconito en el
  // listado, con el mismo umbral 0.001 que el resto de los "compro o no".
  const isotonicasRows = db.prepare(`
    SELECT DISTINCT v.cliente_id FROM ventas v
    JOIN clientes c ON c.cliente_id = v.cliente_id
    WHERE c.personal_comercial = ? AND c.dias_visita = ? AND v.categoria = 'Aguas' AND UPPER(TRIM(v.marca)) = 'FULL SPORT'${periodoClause}
    GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
  `).all(vendedor, dia, ...periodoParams);
  const isotonicasSet = new Set(isotonicasRows.map(r => r.cliente_id));
  const clientesConCategorias = clientes.map(c => ({
    cliente_id: c.cliente_id,
    razon_social: c.razon_social,
    domicilio: c.domicilio,
    horario_entrega: c.horario_entrega || '',
    categorias: catPorCliente[c.cliente_id] || [],
    isotonicas: isotonicasSet.has(c.cliente_id),
  }));
  sendJson(res, 200, {
    total_clientes: clientes.length,
    compradores_por_categoria: compradoresPorCat,
    clientes: clientesConCategorias,
  });
});
route('GET', '/api/clientes/categoria', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const vendedor = parsed.query.vendedor || '';
  const dia = parsed.query.dia || '';
  const categoria = parsed.query.categoria || '';
  const { mes, anio } = getPeriodoActual();
  const periodoClauseV = periodoClauseFor('v', mes, anio) + camioneroExcluidoClause('v');
  const periodoClausePlain = periodoClauseFor(null, mes, anio) + camioneroExcluidoClause(null);
  const periodoParams = (mes && anio) ? [mes, anio, ...CAMIONEROS_EXCLUIDOS_APP] : [...CAMIONEROS_EXCLUIDOS_APP];
  const rows = db.prepare(`
    SELECT c.cliente_id, c.razon_social, c.domicilio, c.horario_entrega FROM clientes c
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
  // Mismo flag "Isotonicas" (marca FULL SPORT dentro de Aguas) que /api/clientes.
  const isotonicaStmt = db.prepare(`
    SELECT 1 FROM ventas
    WHERE cliente_id = ? AND categoria = 'Aguas' AND UPPER(TRIM(marca)) = 'FULL SPORT'${periodoClausePlain}
    GROUP BY cliente_id HAVING SUM(um_hl) >= 0.001
  `);
  const out = rows.map(r => ({
    cliente_id: r.cliente_id,
    razon_social: r.razon_social,
    domicilio: r.domicilio,
    horario_entrega: r.horario_entrega || '',
    categorias: catStmt.all(r.cliente_id, ...periodoParams).map(x => x.categoria),
    isotonicas: !!isotonicaStmt.get(r.cliente_id, ...periodoParams),
  }));
  sendJson(res, 200, out);
});
route('GET', '/api/cliente/:id', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const cliente = db.prepare('SELECT * FROM clientes WHERE cliente_id = ?').get(params.id);
  if (!cliente) return sendJson(res, 404, { error: 'Cliente no encontrado' });
  const { mes, anio } = getPeriodoActual();
  const periodoClause = periodoClauseFor(null, mes, anio) + camioneroExcluidoClause(null);
  const periodoParams = (mes && anio) ? [mes, anio, ...CAMIONEROS_EXCLUIDOS_APP] : [...CAMIONEROS_EXCLUIDOS_APP];
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
  const periodoClause = periodoClauseFor(null, mes, anio) + camioneroExcluidoClause(null);
  const periodoParams = (mes && anio) ? [mes, anio, ...CAMIONEROS_EXCLUIDOS_APP] : [...CAMIONEROS_EXCLUIDOS_APP];
  const rows = db.prepare(`
    SELECT articulo, SUM(um_hl) as hl FROM ventas
    WHERE cliente_id = ? AND marca = ?${periodoClause}
    GROUP BY articulo HAVING SUM(um_hl) >= 0.001
    ORDER BY hl DESC
  `).all(params.id, params.marca, ...periodoParams);
  sendJson(res, 200, rows);
});

const NOMBRES_MES_HIST = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// Historico de un cliente para la app de vendedores: compara el mes en curso
// (el ultimo periodo cargado) contra el mes calendario anterior, marca por
// marca dentro de cada categoria. La lista de marcas es la union de lo
// comprado en CUALQUIERA de los 2 periodos (no solo "lo que compro el mes
// pasado"), para que una marca nueva este mes tambien aparezca con su HL
// actual aunque el mes pasado haya sido 0. Mismo filtro de camioneros
// excluidos que el resto de la app de vendedores (ver CAMIONEROS_EXCLUIDOS_APP).
route('GET', '/api/cliente/:id/historico', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const { mes, anio } = getPeriodoActual();
  if (!mes || !anio) return sendJson(res, 400, { error: 'Todavia no hay un periodo cargado' });
  const { mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(mes, anio);
  const exclClause = camioneroExcluidoClause(null);

  function marcasPorPeriodo(mesP, anioP) {
    return db.prepare(`
      SELECT categoria, marca, SUM(um_hl) as hl FROM ventas
      WHERE cliente_id = ? AND mes = ? AND anio = ?${exclClause}
      GROUP BY categoria, marca HAVING SUM(um_hl) >= 0.001
    `).all(params.id, mesP, anioP, ...CAMIONEROS_EXCLUIDOS_APP);
  }
  function totalPorCategoria(mesP, anioP) {
    const rows = db.prepare(`
      SELECT categoria, SUM(um_hl) as hl FROM ventas
      WHERE cliente_id = ? AND mes = ? AND anio = ?${exclClause}
      GROUP BY categoria
    `).all(params.id, mesP, anioP, ...CAMIONEROS_EXCLUIDOS_APP);
    const out = {};
    for (const r of rows) out[r.categoria] = r.hl || 0;
    return out;
  }

  const actualRows = marcasPorPeriodo(mes, anio);
  const anteriorRows = marcasPorPeriodo(mesAnteriorNum, anioMesAnterior);
  const totalActual = totalPorCategoria(mes, anio);
  const totalAnterior = totalPorCategoria(mesAnteriorNum, anioMesAnterior);

  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const porCategoria = {};
  for (const cat of CATS) porCategoria[cat] = { marcas: {}, total_actual: Math.round((totalActual[cat] || 0) * 1000) / 1000, total_anterior: Math.round((totalAnterior[cat] || 0) * 1000) / 1000 };
  for (const r of actualRows) {
    if (!porCategoria[r.categoria]) continue;
    if (!porCategoria[r.categoria].marcas[r.marca]) porCategoria[r.categoria].marcas[r.marca] = { marca: r.marca, hl_actual: 0, hl_anterior: 0 };
    porCategoria[r.categoria].marcas[r.marca].hl_actual = Math.round((r.hl || 0) * 1000) / 1000;
  }
  for (const r of anteriorRows) {
    if (!porCategoria[r.categoria]) continue;
    if (!porCategoria[r.categoria].marcas[r.marca]) porCategoria[r.categoria].marcas[r.marca] = { marca: r.marca, hl_actual: 0, hl_anterior: 0 };
    porCategoria[r.categoria].marcas[r.marca].hl_anterior = Math.round((r.hl || 0) * 1000) / 1000;
  }

  const resultado = {};
  for (const cat of CATS) {
    const marcas = Object.values(porCategoria[cat].marcas).sort((a, b) => b.hl_anterior - a.hl_anterior || b.hl_actual - a.hl_actual);
    resultado[cat] = { marcas, total_actual: porCategoria[cat].total_actual, total_anterior: porCategoria[cat].total_anterior };
  }

  sendJson(res, 200, {
    mes_actual: mes, anio_actual: anio, nombre_mes_actual: NOMBRES_MES_HIST[mes],
    mes_anterior: mesAnteriorNum, anio_mes_anterior: anioMesAnterior, nombre_mes_anterior: NOMBRES_MES_HIST[mesAnteriorNum],
    categorias: resultado,
  });
});

// Desglose por articulo de UNA marca de un cliente, mismo mes actual vs mes
// anterior que /api/cliente/:id/historico - drill-down al tocar una marca en
// la pantalla de historico de la app de vendedores.
route('GET', '/api/cliente/:id/historico/marca/:marca', async (req, res, params) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const { mes, anio } = getPeriodoActual();
  if (!mes || !anio) return sendJson(res, 400, { error: 'Todavia no hay un periodo cargado' });
  const { mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(mes, anio);
  const exclClause = camioneroExcluidoClause(null);

  function articulosPorPeriodo(mesP, anioP) {
    const rows = db.prepare(`
      SELECT articulo, SUM(um_hl) as hl FROM ventas
      WHERE cliente_id = ? AND marca = ? AND mes = ? AND anio = ?${exclClause}
      GROUP BY articulo HAVING SUM(um_hl) >= 0.001
    `).all(params.id, params.marca, mesP, anioP, ...CAMIONEROS_EXCLUIDOS_APP);
    const out = {};
    for (const r of rows) out[r.articulo || 'SIN ARTICULO'] = r.hl || 0;
    return out;
  }
  const actual = articulosPorPeriodo(mes, anio);
  const anterior = articulosPorPeriodo(mesAnteriorNum, anioMesAnterior);
  const articulos = Array.from(new Set([...Object.keys(actual), ...Object.keys(anterior)]));
  const filas = articulos.map(a => ({
    articulo: a,
    hl_actual: Math.round((actual[a] || 0) * 1000) / 1000,
    hl_anterior: Math.round((anterior[a] || 0) * 1000) / 1000,
  })).sort((x, y) => y.hl_anterior - x.hl_anterior || y.hl_actual - x.hl_actual);

  sendJson(res, 200, {
    marca: params.marca,
    mes_actual: mes, anio_actual: anio, nombre_mes_actual: NOMBRES_MES_HIST[mes],
    mes_anterior: mesAnteriorNum, anio_mes_anterior: anioMesAnterior, nombre_mes_anterior: NOMBRES_MES_HIST[mesAnteriorNum],
    filas,
  });
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
    // IMPORTANTE: antes esto era "INSERT OR REPLACE", que en SQLite borra la
    // fila existente y la vuelve a insertar solo con las columnas listadas acá
    // (cliente_id, razon_social, domicilio, personal_comercial, dias_visita) -
    // todas las demas columnas del cliente (calle, calle1, calle2, localidad,
    // horario_entrega, ramo, categoria_cliente, cargadas por el universo)
    // quedaban en NULL. Por eso Ramo/Categoria aparecian vacios en la pantalla
    // "Datos" de la app de vendedores para CUALQUIER cliente que tuviera una
    // venta en el archivo del dia subido DESPUES del universo: esta subida los
    // pisaba sin querer. Con ON CONFLICT DO UPDATE solo se actualizan los 4
    // campos que vienen del archivo de ventas: el resto de la fila existente
    // (los datos del universo) se mantiene intacto.
    const insCliente = db.prepare(`
      INSERT INTO clientes (cliente_id, razon_social, domicilio, personal_comercial, dias_visita)
      VALUES (?,?,?,?,?)
      ON CONFLICT(cliente_id) DO UPDATE SET
        razon_social = excluded.razon_social,
        domicilio = excluded.domicilio,
        personal_comercial = excluded.personal_comercial,
        dias_visita = excluded.dias_visita
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

// Al arrancar el servidor se borra cualquier archivo temporal de una subida
// de excel que haya quedado a mitad de camino (ej: el servidor se reinicio
// en medio de una subida, o una subida fallo antes de terminar) - uploadJobs
// y uploadFilenames son Maps en memoria que se pierden en cada reinicio, asi
// que cualquier archivo que quede en TMP_DIR ya es basura sin dueño. Si no se
// limpia, se va acumulando (cada archivo de ventas pesa 15-25MB) hasta llenar
// el disco - esto es lo que causaba el error "no space left on device".
try {
  for (const f of fs.readdirSync(TMP_DIR)) {
    try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (e) {}
  }
} catch (e) {}

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

// Selector de periodo: uno o mas pares (mes, anio) elegidos libremente por
// el usuario (multi-select en el frontend, valores "YYYY-MM" separados por
// "|" con el parametro "periodos") - a diferencia del esquema anterior
// (varios meses pero todos del MISMO anio), esto permite elegir un rango
// que cruce el fin de año (ej. Noviembre 2025 a Junio 2026). Cada par se
// codifica como el entero anio*100+mes para poder armar un IN (...) simple
// en SQL. Se acepta tambien el formato viejo "meses"+"anio" (un solo anio)
// y el mas viejo "mes" singular, como fallback de compatibilidad. Con un
// solo periodo seleccionado el comportamiento es identico al de siempre (se
// compara contra el mismo mes del anio anterior y contra el mes calendario
// anterior). Con 2 o mas periodos seleccionados se compara cada mes elegido
// contra el MISMO mes pero un anio antes, y no hay "mes anterior" (un rango
// de varios meses no tiene un unico mes calendario anterior) - se deja null
// y el frontend oculta esa columna.
function parsePeriodos(query) {
  let periodos = parseMulti(query.periodos)
    .map((s) => {
      const [a, m] = s.split('-').map(Number);
      return { anio: a, mes: m };
    })
    .filter((p) => p.anio && p.mes >= 1 && p.mes <= 12);
  if (!periodos.length) {
    const anio = Number(query.anio);
    let meses = parseMulti(query.meses).map(Number).filter(Boolean);
    if (!meses.length && query.mes) meses = [Number(query.mes)];
    meses = Array.from(new Set(meses)).filter((m) => m >= 1 && m <= 12);
    if (anio && meses.length) periodos = meses.map((mes) => ({ anio, mes }));
  }
  const vistos = new Set();
  periodos = periodos.filter((p) => {
    const k = p.anio * 100 + p.mes;
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
  periodos.sort((a, b) => (a.anio * 100 + a.mes) - (b.anio * 100 + b.mes));
  return periodos;
}
function periodosClause(alias, periodos) {
  const col = alias ? alias + '.' : '';
  return {
    clause: ` AND (${col}anio*100 + ${col}mes) IN (${periodos.map(() => '?').join(',')})`,
    params: periodos.map((p) => p.anio * 100 + p.mes),
  };
}
// Mismos meses, un anio antes cada uno (para la comparacion "año anterior").
function periodosAnioAnterior(periodos) {
  return periodos.map((p) => ({ anio: p.anio - 1, mes: p.mes }));
}

route('GET', '/api/filtros/opciones', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const supervisores = db.prepare(`SELECT DISTINCT supervisor FROM ventas WHERE supervisor IS NOT NULL AND supervisor != '' ORDER BY supervisor`).all().map(r => r.supervisor);
  const camioneros = db.prepare(`SELECT DISTINCT camionero FROM ventas WHERE camionero IS NOT NULL AND camionero != '' ORDER BY camionero`).all().map(r => r.camionero);
  const vendedores = db.prepare(`SELECT DISTINCT personal_comercial FROM clientes WHERE personal_comercial IS NOT NULL AND personal_comercial != '' ORDER BY personal_comercial`).all().map(r => r.personal_comercial);
  const dias = db.prepare(`SELECT DISTINCT dias_visita FROM clientes WHERE dias_visita IS NOT NULL AND dias_visita != '' ORDER BY dias_visita`).all().map(r => r.dias_visita);
  // Que vendedor (c.personal_comercial) cae bajo que supervisor (v.supervisor)
  // - se calcula desde las ventas reales (join por cliente_id), no desde la
  // tabla de referencia Vendedor-Supervisor, para no depender de que los
  // nombres de esa tabla matcheen exacto con los de "universo" (ver bug de
  // "SIN ASIGNAR"). Usado por el frontend para que, al filtrar por
  // Supervisor, el boton de Vendedor solo liste los vendedores de esa mesa.
  const vendedoresPorSupervisorRows = db.prepare(`
    SELECT DISTINCT v.supervisor as supervisor, c.personal_comercial as vendedor
    FROM ventas v JOIN clientes c ON c.cliente_id = v.cliente_id
    WHERE v.supervisor IS NOT NULL AND v.supervisor != ''
      AND c.personal_comercial IS NOT NULL AND c.personal_comercial != ''
  `).all();
  const vendedoresPorSupervisor = {};
  for (const r of vendedoresPorSupervisorRows) {
    if (!vendedoresPorSupervisor[r.supervisor]) vendedoresPorSupervisor[r.supervisor] = [];
    vendedoresPorSupervisor[r.supervisor].push(r.vendedor);
  }
  for (const k in vendedoresPorSupervisor) vendedoresPorSupervisor[k].sort();
  sendJson(res, 200, { supervisores, camioneros, vendedores, dias, vendedores_por_supervisor: vendedoresPorSupervisor });
});

// Lista de pares (mes, anio) que realmente tienen datos cargados - usado por
// el frontend para armar el selector de periodo (solo se puede elegir un
// periodo que exista, no hace falta un selector de año separado).
route('GET', '/api/periodos-disponibles', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const rows = db.prepare(`
    SELECT DISTINCT anio, mes FROM ventas
    WHERE anio IS NOT NULL AND mes IS NOT NULL
    ORDER BY anio, mes
  `).all();
  sendJson(res, 200, rows.map(r => ({ anio: r.anio, mes: r.mes })));
});

route('GET', '/api/kpis', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  if (!periodos.length) return sendJson(res, 400, { error: 'Faltan parametros de periodo' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const { clause: pClause, params: pParams } = periodosClause('v', periodos);
  const { clause: paClause, params: paParams } = periodosClause('v', periodosAnioAnterior(periodos));
  const soloUnMes = periodos.length === 1;

  const diasConfigRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('dias_configurados');
  const diasConfigurados = diasConfigRow ? Number(diasConfigRow.value) : null;
  // dias_venta_reales se guarda por UN mes puntual al subir el archivo - con
  // varios meses seleccionados no hay forma confiable de sumarlo, asi que
        let diasReales = null;
  if (soloUnMes) {
    const diasRealesRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(`dias_reales_${periodos[0].anio}_${String(periodos[0].mes).padStart(2, '0')}`);
    diasReales = diasRealesRow ? Number(diasRealesRow.value) : null;
  }

  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));

  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  const resultado = {};
  for (const cat of CATS) {
    const actualRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ?${pClause}${clause}`).get(cat, ...pParams, ...params);
    const anteriorRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ?${paClause}${clause}`).get(cat, ...paParams, ...params);
    const actual = actualRow.total || 0;
    const anterior = anteriorRow.total || 0;
    let mesAnterior = null, variacionMesPct = null;
    if (soloUnMes) {
      const mesAnteriorRow = db.prepare(`SELECT SUM(v.um_hl) as total FROM ventas v ${join} WHERE v.categoria = ? AND v.mes = ? AND v.anio = ?${clause}`).get(cat, mesAnteriorNum, anioMesAnterior, ...params);
      mesAnterior = mesAnteriorRow.total || 0;
      variacionMesPct = mesAnterior > 0 ? ((actual - mesAnterior) / mesAnterior * 100) : null;
    }
    const proyectado = (diasReales && diasConfigurados) ? (actual / diasReales * diasConfigurados) : null;
    const variacionPct = anterior > 0 ? ((actual - anterior) / anterior * 100) : null;
    resultado[cat] = {
      actual: Math.round(actual * 1000) / 1000,
      anio_anterior: Math.round(anterior * 1000) / 1000,
      mes_anterior: mesAnterior !== null ? Math.round(mesAnterior * 1000) / 1000 : null,
      proyectado: proyectado !== null ? Math.round(proyectado * 1000) / 1000 : null,
      variacion_pct: variacionPct !== null ? Math.round(variacionPct * 10) / 10 : null,
      variacion_mes_pct: variacionMesPct !== null ? Math.round(variacionMesPct * 10) / 10 : null,
    };
  }
  sendJson(res, 200, {
    periodos,
    mes_anterior_num: mesAnteriorNum,
    anio_mes_anterior: anioMesAnterior,
    dias_configurados: diasConfigurados,
    dias_venta_reales: diasReales,
    categorias: resultado,
  });
});
// Mismo cuadro que /api/kpis (actual, proyectado, mes anterior, año anterior
// y sus variaciones) pero contando CLIENTES DISTINTOS por categoria en vez de
// sumar HL. Usa un umbral mas chico (0.0001, contra 0.001 en el resto de la
// app) a pedido puntual del usuario para este cuadro.
route('GET', '/api/kpis-compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  if (!periodos.length) return sendJson(res, 400, { error: 'Faltan parametros de periodo' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const soloUnMes = periodos.length === 1;

  const diasConfigRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('dias_configurados');
  const diasConfigurados = diasConfigRow ? Number(diasConfigRow.value) : null;
  let diasReales = null;
  if (soloUnMes) {
    const diasRealesRow = db.prepare('SELECT value FROM meta WHERE key = ?').get(`dias_reales_${periodos[0].anio}_${String(periodos[0].mes).padStart(2, '0')}`);
    diasReales = diasRealesRow ? Number(diasRealesRow.value) : null;
  }

  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));

  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];
  // Cuenta clientes distintos que compraron la categoria en CUALQUIERA de los
  // periodos de periodosArr (sumando su HL en esos periodos para el umbral) -
  // un cliente que compro en varios de esos periodos cuenta UNA sola vez,
  // nunca sumado por mes.
  function contarCompradores(cat, periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const row = db.prepare(`
      SELECT COUNT(*) as n FROM (
        SELECT v.cliente_id FROM ventas v ${join}
        WHERE v.categoria = ?${pClause}${clause}
        GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.0001
      )
    `).get(cat, ...pParams, ...params);
    return row.n || 0;
  }
  const resultado = {};
  for (const cat of CATS) {
    const actual = contarCompradores(cat, periodos);
    const anterior = contarCompradores(cat, periodosAnioAnterior(periodos));
    let mesAnterior = null, variacionMesPct = null;
    if (soloUnMes) {
      mesAnterior = contarCompradores(cat, [{ anio: anioMesAnterior, mes: mesAnteriorNum }]);
      variacionMesPct = mesAnterior > 0 ? ((actual - mesAnterior) / mesAnterior * 100) : null;
    }
    const proyectado = (diasReales && diasConfigurados) ? (actual / diasReales * diasConfigurados) : null;
    const variacionPct = anterior > 0 ? ((actual - anterior) / anterior * 100) : null;
    resultado[cat] = {
      actual,
      anio_anterior: anterior,
      mes_anterior: mesAnterior,
      proyectado: proyectado !== null ? Math.round(proyectado) : null,
      variacion_pct: variacionPct !== null ? Math.round(variacionPct * 10) / 10 : null,
      variacion_mes_pct: variacionMesPct !== null ? Math.round(variacionMesPct * 10) / 10 : null,
    };
  }
  sendJson(res, 200, {
    periodos,
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
// Cambio de la PROPIA contraseña (cualquier usuario logueado, no requiere ser
// admin) - a diferencia de /reset-password (solo admin, para otros usuarios),
// esta pide la contraseña actual para confirmar identidad.
route('POST', '/api/me/change-password', async (req, res) => {
  const session = requireAuth(req, res, ['admin', 'supervisor', 'vendedor']);
  if (!session) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) {
    return sendJson(res, 400, { error: 'Faltan datos: contraseña actual y nueva' });
  }
  if (newPassword.length < 4) {
    return sendJson(res, 400, { error: 'La contraseña nueva debe tener al menos 4 caracteres' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  if (!user || !authLib.verifyPassword(currentPassword, user.salt, user.password_hash)) {
    return sendJson(res, 400, { error: 'La contraseña actual es incorrecta' });
  }
  const { hash, salt } = authLib.hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, session.user_id);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/ranking/marcas', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  if (!periodos.length || !categoria) return sendJson(res, 400, { error: 'Faltan parametros de periodo y categoria' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const { clause: pClause, params: pParams } = periodosClause('v', periodos);
  const rows = db.prepare(`
    SELECT v.marca as marca, SUM(v.um_hl) as hl FROM ventas v ${join}
    WHERE v.categoria = ?${pClause}${clause}
    GROUP BY v.marca HAVING SUM(v.um_hl) >= 0.001
    ORDER BY hl DESC
  `).all(categoria, ...pParams, ...params);
  sendJson(res, 200, rows.map(r => ({ marca: r.marca, hl: Math.round(r.hl * 1000) / 1000 })));
});
// Cantidad de compradores (clientes distintos) por marca, para UNA categoria -
// version "compradores" de /api/ranking/marcas (que suma HL). El total de la
// categoria NO es la suma de compradores de cada marca (un cliente que
// compro 2 marcas no se cuenta 2 veces): se cuenta aparte, directo por SQL,
// con el mismo umbral 0.0001 que usa la tarjeta de Compradores
// (/api/kpis-compradores) para que el numero coincida.
route('GET', '/api/ranking/marcas-compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  if (!periodos.length || !categoria) return sendJson(res, 400, { error: 'Faltan parametros de periodo y categoria' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const { clause: pClause, params: pParams } = periodosClause('v', periodos);
  const filas = db.prepare(`
    SELECT marca, COUNT(*) as n FROM (
      SELECT v.marca as marca, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
      FROM ventas v ${join}
      WHERE v.categoria = ?${pClause}${clause}
      GROUP BY v.marca, v.cliente_id
      HAVING SUM(v.um_hl) >= 0.001
    ) GROUP BY marca
    ORDER BY n DESC
  `).all(categoria, ...pParams, ...params);
  const totalRow = db.prepare(`
    SELECT COUNT(*) as n FROM (
      SELECT v.cliente_id FROM ventas v ${join}
      WHERE v.categoria = ?${pClause}${clause}
      GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.0001
    )
  `).get(categoria, ...pParams, ...params);
  sendJson(res, 200, { filas: filas.map(r => ({ marca: r.marca, n: r.n })), total: totalRow.n || 0 });
});
route('GET', '/api/ranking/clientes', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  const marca = parsed.query.marca || '';
  if (!periodos.length || !categoria || !marca) return sendJson(res, 400, { error: 'Faltan parametros de periodo, categoria y marca' });
  const filtros = buildFiltros(parsed.query);
  const { clause: pClause, params: pParams } = periodosClause('v', periodos);
  const rows = db.prepare(`
    SELECT v.cliente_id as cliente_id, c.razon_social as razon_social, c.domicilio as domicilio, SUM(v.um_hl) as hl
    FROM ventas v LEFT JOIN clientes c ON c.cliente_id = v.cliente_id
    WHERE v.categoria = ? AND v.marca = ?${pClause}${filtros.clause}
    GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
    ORDER BY hl DESC LIMIT 15
  `).all(categoria, marca, ...pParams, ...filtros.params);
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

// Actualiza/agrega clientes a partir del archivo "universo" (maestro de
// clientes del ERP, distinto del archivo de venta del dia). Solo admin -
// a pedido del usuario, es la unica forma de que aparezcan clientes nuevos
// en la app de vendedores (la carga de venta del dia NUNCA toca la tabla
// clientes, ver guardarVentas/finalizarYGuardar mas arriba). Es un upsert
// (INSERT OR REPLACE por cliente_id): un cliente que no este en este
// archivo no se borra, solo se actualizan/agregan los que si vienen.
route('POST', '/api/referencia/universo', async (req, res) => {
  if (!requireAuth(req, res, ['admin'])) return;
  const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}');
  if (!Array.isArray(body.clientes)) return sendJson(res, 400, { error: 'Falta clientes (array)' });
  let cantidad = 0;
  db.exec('BEGIN');
  try {
    const insCliente = db.prepare(`
      INSERT OR REPLACE INTO clientes (cliente_id, razon_social, domicilio, personal_comercial, dias_visita, calle, calle1, calle2, localidad, horario_entrega, ramo, categoria_cliente)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    for (const c of body.clientes) {
      if (!c || c.cliente_id === undefined || c.cliente_id === null || c.cliente_id === '') continue;
      insCliente.run(
        String(c.cliente_id), c.razon_social || '', c.domicilio || '', c.personal_comercial || '', c.dias_visita || '',
        c.calle || '', c.calle1 || '', c.calle2 || '', c.localidad || '', c.horario_entrega || '', c.ramo || '', c.categoria_cliente || ''
      );
      cantidad++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return sendJson(res, 500, { error: 'Error guardando clientes: ' + e.message });
  }
  sendJson(res, 200, { ok: true, cantidad });
});

route('GET', '/api/ranking/clientes-categoria', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  const limit = Math.min(Number(parsed.query.limit) || 20, 100);
  if (!periodos.length || !categoria) return sendJson(res, 400, { error: 'Faltan parametros de periodo y categoria' });
  const filtros = buildFiltros(parsed.query);
  const { clause: pClause, params: pParams } = periodosClause('v', periodos);
  const rows = db.prepare(`
    SELECT v.cliente_id as cliente_id, c.razon_social as razon_social, c.domicilio as domicilio, SUM(v.um_hl) as hl
    FROM ventas v LEFT JOIN clientes c ON c.cliente_id = v.cliente_id
    WHERE v.categoria = ?${pClause}${filtros.clause}
    GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
    ORDER BY hl DESC LIMIT ?
  `).all(categoria, ...pParams, ...filtros.params, limit);
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

// "AMSTEL IPANEMA" y "AMSTEL LAGER" son la misma marca renombrada en algun
// momento dentro de los datos historicos de ventas. Se unifican bajo un solo
// nombre para que las comparaciones entre periodos (actual / mes anterior /
// año anterior) en marca-canal no queden rotas por el cambio de nombre.
function normalizarMarca(marca) {
  if (marca === 'AMSTEL IPANEMA') return 'AMSTEL LAGER';
  return marca;
}

route('GET', '/api/canal', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  if (!periodos.length) return sendJson(res, 400, { error: 'Faltan parametros de periodo' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const soloUnMes = periodos.length === 1;
  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];

  function volumenPorCanal(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const rows = db.prepare(`
      SELECT v.canal as canal, v.categoria as categoria, SUM(v.um_hl) as hl
      FROM ventas v ${join}
      WHERE 1=1${pClause}${clause}
      GROUP BY v.canal, v.categoria
    `).all(...pParams, ...params);
    const out = {};
    for (const r of rows) {
      const canal = r.canal || 'SIN CANAL';
      if (!out[canal]) out[canal] = {};
      out[canal][r.categoria] = r.hl || 0;
    }
    return out;
  }

  const actualData = volumenPorCanal(periodos);
  const anioAnteriorData = volumenPorCanal(periodosAnioAnterior(periodos));
  const mesAnteriorData = soloUnMes ? volumenPorCanal([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : {};
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
      categorias[cat] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: soloUnMes ? r3(ma) : null };
      tA += a; tAA += aa; tMA += ma;
    }
    return { canal, categorias, total: { actual: r3(tA), anio_anterior: r3(tAA), mes_anterior: soloUnMes ? r3(tMA) : null } };
  }

  const filas = canales.map(armarFila);
  const totalGeneral = { categorias: {}, total: { actual: 0, anio_anterior: 0, mes_anterior: soloUnMes ? 0 : null } };
  for (const cat of CATS) {
    let a = 0, aa = 0, ma = 0;
    for (const f of filas) { a += f.categorias[cat].actual; aa += f.categorias[cat].anio_anterior; ma += (f.categorias[cat].mes_anterior || 0); }
    totalGeneral.categorias[cat] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: soloUnMes ? r3(ma) : null };
    totalGeneral.total.actual += a; totalGeneral.total.anio_anterior += aa; if (soloUnMes) totalGeneral.total.mes_anterior += ma;
  }
  totalGeneral.total = { actual: r3(totalGeneral.total.actual), anio_anterior: r3(totalGeneral.total.anio_anterior), mes_anterior: soloUnMes ? r3(totalGeneral.total.mes_anterior) : null };

  sendJson(res, 200, {
    periodos, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    filas, total_general: totalGeneral,
  });
});

route('GET', '/api/canal-compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  if (!periodos.length) return sendJson(res, 400, { error: 'Faltan parametros de periodo' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const soloUnMes = periodos.length === 1;
  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));
  const CATS = ['Cervezas', 'Aguas', 'Vinos', 'Sidras'];

  // Cliente distinto que compro en CUALQUIERA de los periodos de periodosArr
  // cuenta una sola vez (por canal, por categoria y en el total general) -
  // mismo criterio que contarCompradores en /api/kpis-compradores.
  function compradoresPorCanal(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const rows = db.prepare(`
      SELECT canal, categoria, COUNT(*) as n FROM (
        SELECT v.canal as canal, v.categoria as categoria, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE 1=1${pClause}${clause}
        GROUP BY v.canal, v.categoria, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY canal, categoria
    `).all(...pParams, ...params);
    const porCat = {};
    for (const r of rows) {
      const canal = r.canal || 'SIN CANAL';
      if (!porCat[canal]) porCat[canal] = {};
      porCat[canal][r.categoria] = r.n;
    }
    const totalRows = db.prepare(`
      SELECT canal, COUNT(*) as n FROM (
        SELECT v.canal as canal, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE 1=1${pClause}${clause}
                GROUP BY v.canal, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY canal
    `).all(...pParams, ...params);
    const totales = {};
    for (const r of totalRows) totales[r.canal || 'SIN CANAL'] = r.n;
    return { porCat, totales };
  }

  function totalPorCategoria(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const rows = db.prepare(`
      SELECT categoria, COUNT(*) as n FROM (
        SELECT v.categoria as categoria, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE 1=1${pClause}${clause}
        GROUP BY v.categoria, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY categoria
    `).all(...pParams, ...params);
    const out = {};
    for (const r of rows) out[r.categoria] = r.n;
    return out;
  }
  function totalGeneralClientes(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const row = db.prepare(`
      SELECT COUNT(*) as n FROM (
        SELECT v.cliente_id FROM ventas v ${join}
        WHERE 1=1${pClause}${clause}
        GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
      )
    `).get(...pParams, ...params);
    return row.n || 0;
  }

  const actualData = compradoresPorCanal(periodos);
  const anioAnteriorData = compradoresPorCanal(periodosAnioAnterior(periodos));
  const mesAnteriorData = soloUnMes ? compradoresPorCanal([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : { porCat: {}, totales: {} };
  const canales = Array.from(new Set([
    ...Object.keys(actualData.totales), ...Object.keys(anioAnteriorData.totales), ...Object.keys(mesAnteriorData.totales),
  ])).sort();

  function armarFila(canal) {
    const categorias = {};
    for (const cat of CATS) {
      categorias[cat] = {
        actual: (actualData.porCat[canal] && actualData.porCat[canal][cat]) || 0,
        anio_anterior: (anioAnteriorData.porCat[canal] && anioAnteriorData.porCat[canal][cat]) || 0,
        mes_anterior: soloUnMes ? ((mesAnteriorData.porCat[canal] && mesAnteriorData.porCat[canal][cat]) || 0) : null,
      };
    }
    return {
      canal, categorias,
      total: {
        actual: actualData.totales[canal] || 0,
        anio_anterior: anioAnteriorData.totales[canal] || 0,
        mes_anterior: soloUnMes ? (mesAnteriorData.totales[canal] || 0) : null,
      },
    };
  }

  const filas = canales.map(armarFila);
  const totalCatActual = totalPorCategoria(periodos);
  const totalCatAnioAnt = totalPorCategoria(periodosAnioAnterior(periodos));
  const totalCatMesAnt = soloUnMes ? totalPorCategoria([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : {};
  const totalGeneral = {
    categorias: {},
    total: {
      actual: totalGeneralClientes(periodos),
      anio_anterior: totalGeneralClientes(periodosAnioAnterior(periodos)),
      mes_anterior: soloUnMes ? totalGeneralClientes([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : null,
    },
  };
  for (const cat of CATS) {
    totalGeneral.categorias[cat] = {
      actual: totalCatActual[cat] || 0,
      anio_anterior: totalCatAnioAnt[cat] || 0,
      mes_anterior: soloUnMes ? (totalCatMesAnt[cat] || 0) : null,
    };
  }

  sendJson(res, 200, {
    periodos, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
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
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  if (!periodos.length || !categoria) return sendJson(res, 400, { error: 'Faltan parametros de periodo y categoria' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const soloUnMes = periodos.length === 1;
  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));

  function volumenPorMarca(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const rows = db.prepare(`
      SELECT v.marca as marca, v.canal as canal, SUM(v.um_hl) as hl
      FROM ventas v ${join}
      WHERE v.categoria = ?${pClause}${clause}
      GROUP BY v.marca, v.canal
    `).all(categoria, ...pParams, ...params);
    const out = {};
    for (const r of rows) {
      const marca = normalizarMarca(r.marca || 'SIN MARCA');
      const canal = r.canal || 'SIN CANAL';
      if (!out[marca]) out[marca] = {};
      out[marca][canal] = (out[marca][canal] || 0) + (r.hl || 0);
    }
    return out;
  }

  const actualData = volumenPorMarca(periodos);
  const anioAnteriorData = volumenPorMarca(periodosAnioAnterior(periodos));
  const mesAnteriorData = soloUnMes ? volumenPorMarca([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : {};
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
      porGrupo[canal] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: soloUnMes ? r3(ma) : null };
      tA += a; tAA += aa; tMA += ma;
    }
    return { nombre: marca, porGrupo, total: { actual: r3(tA), anio_anterior: r3(tAA), mes_anterior: soloUnMes ? r3(tMA) : null } };
  }

  const filas = marcas.map(armarFila).sort((a, b) => b.total.actual - a.total.actual);
  const totalGeneral = { porGrupo: {}, total: { actual: 0, anio_anterior: 0, mes_anterior: soloUnMes ? 0 : null } };
  for (const canal of canales) {
    let a = 0, aa = 0, ma = 0;
    for (const f of filas) { a += f.porGrupo[canal].actual; aa += f.porGrupo[canal].anio_anterior; ma += (f.porGrupo[canal].mes_anterior || 0); }
    totalGeneral.porGrupo[canal] = { actual: r3(a), anio_anterior: r3(aa), mes_anterior: soloUnMes ? r3(ma) : null };
    totalGeneral.total.actual += a; totalGeneral.total.anio_anterior += aa; if (soloUnMes) totalGeneral.total.mes_anterior += ma;
  }
  totalGeneral.total = { actual: r3(totalGeneral.total.actual), anio_anterior: r3(totalGeneral.total.anio_anterior), mes_anterior: soloUnMes ? r3(totalGeneral.total.mes_anterior) : null };

  sendJson(res, 200, {
    periodos, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    grupos: canales, filas, total_general: totalGeneral,
  });
});

// Compradores (clientes distintos) por marca y canal, para UNA categoria a la
// vez. Misma idea que /api/marca-canal pero contando clientes en vez de sumar HL.
route('GET', '/api/marca-canal-compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  if (!periodos.length || !categoria) return sendJson(res, 400, { error: 'Faltan parametros de periodo y categoria' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const soloUnMes = periodos.length === 1;
  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));

  // Cliente distinto que compro esa marca en CUALQUIERA de los periodos de
  // periodosArr cuenta una sola vez (por canal), no una vez por mes.
  function compradoresPorMarca(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const rows = db.prepare(`
      SELECT marca, canal, COUNT(*) as n FROM (
        SELECT
          CASE WHEN v.marca = 'AMSTEL IPANEMA' THEN 'AMSTEL LAGER' ELSE v.marca END as marca,
          v.canal as canal, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE v.categoria = ?${pClause}${clause}
        GROUP BY marca, v.canal, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY marca, canal
    `).all(categoria, ...pParams, ...params);
    const out = {};
    for (const r of rows) {
      const marca = r.marca || 'SIN MARCA';
      const canal = r.canal || 'SIN CANAL';
      if (!out[marca]) out[marca] = {};
      out[marca][canal] = r.n;
    }
    return out;
  }

  const actualData = compradoresPorMarca(periodos);
  const anioAnteriorData = compradoresPorMarca(periodosAnioAnterior(periodos));
  const mesAnteriorData = soloUnMes ? compradoresPorMarca([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : {};
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
        mes_anterior: soloUnMes ? ((mesAnteriorData[marca] && mesAnteriorData[marca][canal]) || 0) : null,
      };
    }
    let tA = 0, tAA = 0, tMA = 0;
    for (const canal of canales) { tA += porGrupo[canal].actual; tAA += porGrupo[canal].anio_anterior; tMA += (porGrupo[canal].mes_anterior || 0); }
    return { nombre: marca, porGrupo, total: { actual: tA, anio_anterior: tAA, mes_anterior: soloUnMes ? tMA : null } };
  }

  const filas = marcas.map(armarFila).sort((a, b) => b.total.actual - a.total.actual);

  // El "Total general" NO es la suma de los compradores de cada marca: un
  // cliente que compro 2 marcas de la categoria cuenta como 1 comprador, no
  // como 2 (eso es lo que pasaba antes, sumando filas.porGrupo[canal], y
  // por eso el total general daba mas alto que la cantidad real de
  // compradores). Se cuenta clientes distintos directo por SQL - por canal
  // (agrupando marcas) y en total (agrupando canales tambien), igual que
  // hace /api/kpis-compradores para la tarjeta "Compradores" de arriba
  // (mismo umbral 0.0001, para que el numero coincida con esa tarjeta). Con
  // varios periodos seleccionados, cuenta clientes que compraron al menos
  // una vez en CUALQUIERA de esos periodos (nunca sumado por mes).
  function compradoresDistintosPorCanal(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const porCanalRows = db.prepare(`
      SELECT canal, COUNT(*) as n FROM (
        SELECT v.canal as canal, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE v.categoria = ?${pClause}${clause}
        GROUP BY v.canal, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.0001
      ) GROUP BY canal
    `).all(categoria, ...pParams, ...params);
    const porCanal = {};
    for (const r of porCanalRows) porCanal[r.canal || 'SIN CANAL'] = r.n;
    const totalRow = db.prepare(`
      SELECT COUNT(*) as n FROM (
        SELECT v.cliente_id FROM ventas v ${join}
        WHERE v.categoria = ?${pClause}${clause}
        GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.0001
      )
    `).get(categoria, ...pParams, ...params);
    return { porCanal, total: totalRow.n || 0 };
  }
  const totalesActual = compradoresDistintosPorCanal(periodos);
  const totalesAnioAnt = compradoresDistintosPorCanal(periodosAnioAnterior(periodos));
  const totalesMesAnt = soloUnMes ? compradoresDistintosPorCanal([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : { porCanal: {}, total: 0 };
  const totalGeneral = {
    porGrupo: {},
    total: {
      actual: totalesActual.total,
      anio_anterior: totalesAnioAnt.total,
      mes_anterior: soloUnMes ? totalesMesAnt.total : null,
    },
  };
  for (const canal of canales) {
    totalGeneral.porGrupo[canal] = {
      actual: totalesActual.porCanal[canal] || 0,
      anio_anterior: totalesAnioAnt.porCanal[canal] || 0,
      mes_anterior: soloUnMes ? (totalesMesAnt.porCanal[canal] || 0) : null,
    };
  }

  sendJson(res, 200, {
    periodos, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    grupos: canales, filas, total_general: totalGeneral,
  });
});

// Volumen (HL) por ARTICULO para UNA marca de UNA categoria puntual -
// drill-down al hacer clic en el nombre de una marca dentro de "Volumen por
// marca y canal". Misma logica de periodo (multi-periodo) y misma forma de
// columnas (actual / año anterior / [mes anterior], este ultimo solo con un
// mes seleccionado) que el resto de los endpoints de periodo.
route('GET', '/api/marca-articulo', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  const marca = parsed.query.marca || '';
  if (!periodos.length || !categoria || !marca) return sendJson(res, 400, { error: 'Faltan parametros de periodo, categoria y marca' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const soloUnMes = periodos.length === 1;
  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));
  const marcaCase = `CASE WHEN v.marca = 'AMSTEL IPANEMA' THEN 'AMSTEL LAGER' ELSE v.marca END`;

  function volumenPorArticulo(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const rows = db.prepare(`
      SELECT v.articulo as articulo, SUM(v.um_hl) as hl
      FROM ventas v ${join}
      WHERE v.categoria = ? AND ${marcaCase} = ?${pClause}${clause}
      GROUP BY v.articulo
    `).all(categoria, marca, ...pParams, ...params);
    const out = {};
    for (const r of rows) out[r.articulo || 'SIN ARTICULO'] = r.hl || 0;
    return out;
  }

  const actualData = volumenPorArticulo(periodos);
  const anioAnteriorData = volumenPorArticulo(periodosAnioAnterior(periodos));
  const mesAnteriorData = soloUnMes ? volumenPorArticulo([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : {};
  const articulos = Array.from(new Set([
    ...Object.keys(actualData), ...Object.keys(anioAnteriorData), ...Object.keys(mesAnteriorData),
  ])).sort();

  const r3 = (n) => Math.round((n || 0) * 1000) / 1000;
  function armarFila(articulo) {
    const a = actualData[articulo] || 0;
    const aa = anioAnteriorData[articulo] || 0;
    const ma = mesAnteriorData[articulo] || 0;
    return { nombre: articulo, actual: r3(a), anio_anterior: r3(aa), mes_anterior: soloUnMes ? r3(ma) : null };
  }

  const filas = articulos.map(armarFila).sort((a, b) => b.actual - a.actual);
  let tA = 0, tAA = 0, tMA = 0;
  for (const f of filas) { tA += f.actual; tAA += f.anio_anterior; if (soloUnMes) tMA += (f.mes_anterior || 0); }
  const totalGeneral = { actual: r3(tA), anio_anterior: r3(tAA), mes_anterior: soloUnMes ? r3(tMA) : null };

  sendJson(res, 200, {
    periodos, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    marca, categoria, filas, total_general: totalGeneral,
  });
});

// Compradores (clientes distintos) por ARTICULO para UNA marca de UNA
// categoria puntual - drill-down desde "Compradores por marca y canal".
// Mismo criterio de conteo directo por SQL que el resto de los endpoints de
// compradores (nunca sumado por articulo, para no contar 2 veces a un
// cliente que compro mas de un articulo de la marca).
route('GET', '/api/marca-articulo-compradores', async (req, res) => {
  if (!requireAuth(req, res, ['admin', 'supervisor', 'vendedor'])) return;
  const parsed = url.parse(req.url, true);
  const periodos = parsePeriodos(parsed.query);
  const categoria = parsed.query.categoria || '';
  const marca = parsed.query.marca || '';
  if (!periodos.length || !categoria || !marca) return sendJson(res, 400, { error: 'Faltan parametros de periodo, categoria y marca' });
  const { clause, params, join } = buildFiltros(parsed.query);
  const soloUnMes = periodos.length === 1;
  let mesAnteriorNum = null, anioMesAnterior = null;
  if (soloUnMes) ({ mesAnteriorNum, anioMesAnterior } = periodoMesAnterior(periodos[0].mes, periodos[0].anio));
  const marcaCase = `CASE WHEN v.marca = 'AMSTEL IPANEMA' THEN 'AMSTEL LAGER' ELSE v.marca END`;

  function compradoresPorArticulo(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const rows = db.prepare(`
      SELECT articulo, COUNT(*) as n FROM (
        SELECT v.articulo as articulo, v.cliente_id as cliente_id, SUM(v.um_hl) as hl
        FROM ventas v ${join}
        WHERE v.categoria = ? AND ${marcaCase} = ?${pClause}${clause}
        GROUP BY v.articulo, v.cliente_id
        HAVING SUM(v.um_hl) >= 0.001
      ) GROUP BY articulo
    `).all(categoria, marca, ...pParams, ...params);
    const out = {};
    for (const r of rows) out[r.articulo || 'SIN ARTICULO'] = r.n;
    return out;
  }
  // Total de la marca (no sumado por articulo, sino contado directo) - un
  // cliente que compro 2 articulos de la marca cuenta 1 sola vez.
  function totalMarcaDistintos(periodosArr) {
    const { clause: pClause, params: pParams } = periodosClause('v', periodosArr);
    const row = db.prepare(`
      SELECT COUNT(*) as n FROM (
        SELECT v.cliente_id FROM ventas v ${join}
        WHERE v.categoria = ? AND ${marcaCase} = ?${pClause}${clause}
        GROUP BY v.cliente_id HAVING SUM(v.um_hl) >= 0.001
      )
    `).get(categoria, marca, ...pParams, ...params);
    return row.n || 0;
  }

  const actualData = compradoresPorArticulo(periodos);
  const anioAnteriorData = compradoresPorArticulo(periodosAnioAnterior(periodos));
  const mesAnteriorData = soloUnMes ? compradoresPorArticulo([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : {};
  const articulos = Array.from(new Set([
    ...Object.keys(actualData), ...Object.keys(anioAnteriorData), ...Object.keys(mesAnteriorData),
  ])).sort();

  function armarFila(articulo) {
    return {
      nombre: articulo,
      actual: actualData[articulo] || 0,
      anio_anterior: anioAnteriorData[articulo] || 0,
      mes_anterior: soloUnMes ? (mesAnteriorData[articulo] || 0) : null,
    };
  }
  const filas = articulos.map(armarFila).sort((a, b) => b.actual - a.actual);

  const totalGeneral = {
    actual: totalMarcaDistintos(periodos),
    anio_anterior: totalMarcaDistintos(periodosAnioAnterior(periodos)),
    mes_anterior: soloUnMes ? totalMarcaDistintos([{ anio: anioMesAnterior, mes: mesAnteriorNum }]) : null,
  };

  sendJson(res, 200, {
    periodos, mes_anterior_num: mesAnteriorNum, anio_mes_anterior: anioMesAnterior,
    marca, categoria, filas, total_general: totalGeneral,
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
