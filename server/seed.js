// seed.js - Crea usuarios iniciales. Se corre una sola vez: node server/seed.js
const auth = require('./auth');
const db = require('./db');

function upsertUser(username, password, role) {
  const existing = auth.findUserByUsername(username);
  if (existing) {
    const { hash, salt } = auth.hashPassword(password);
    db.prepare('UPDATE users SET password_hash=?, salt=?, role=? WHERE username=?')
      .run(hash, salt, role, username.toLowerCase());
    console.log(`Actualizado: ${username} (${role})`);
  } else {
    auth.createUser(username, password, role);
    console.log(`Creado: ${username} (${role})`);
  }
}

upsertUser('surdorado', 'luca1901', 'admin');
upsertUser('vendedores', 'vende2026', 'vendedor');

console.log('Listo.');
