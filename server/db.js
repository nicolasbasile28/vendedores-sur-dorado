// db.js - Todo el acceso a base de datos (SQLite embebido, sin dependencias externas)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','supervisor','vendedor'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS clientes (
    cliente_id TEXT PRIMARY KEY,
    razon_social TEXT,
    domicilio TEXT,
    personal_comercial TEXT,
    dias_visita TEXT
  );
  CREATE TABLE IF NOT EXISTS ventas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cliente_id TEXT NOT NULL,
    categoria TEXT NOT NULL,
    marca TEXT NOT NULL,
    articulo TEXT NOT NULL,
    um_hl REAL NOT NULL,
    supervisor TEXT,
    camionero TEXT,
    tipo_documento TEXT,
    mes INTEGER,
    anio INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ventas_cliente ON ventas(cliente_id);
  CREATE INDEX IF NOT EXISTS idx_ventas_periodo ON ventas(anio, mes);
  CREATE INDEX IF NOT EXISTS idx_ventas_supervisor ON ventas(supervisor);
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);
module.exports = db;
