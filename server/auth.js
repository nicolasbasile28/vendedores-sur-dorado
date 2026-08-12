// auth.js - hashing de contraseñas y manejo de sesiones, usando solo node:crypto
const crypto = require('crypto');
const db = require('./db');

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

function createUser(username, password, role) {
  const { hash, salt } = hashPassword(password);
  const stmt = db.prepare('INSERT INTO users (username, password_hash, salt, role) VALUES (?,?,?,?)');
  stmt.run(username.toLowerCase(), hash, salt, role);
}

function findUserByUsername(username) {
  const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
  return stmt.get(username.toLowerCase());
}

function login(username, password) {
  const user = findUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.salt, user.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const stmt = db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)');
  stmt.run(token, user.id, new Date().toISOString());
  return { token, role: user.role, username: user.username };
}

function getSession(token) {
  if (!token) return null;
  const stmt = db.prepare(`
    SELECT s.token, u.id as user_id, u.username, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `);
  return stmt.get(token);
}

function logout(token) {
  const stmt = db.prepare('DELETE FROM sessions WHERE token = ?');
  stmt.run(token);
}

module.exports = { createUser, findUserByUsername, login, getSession, logout, hashPassword };
