const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '4mb' }));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.warn('Falha ao ler db.json:', e.message); }
  return { state: null, state_updated_at: null, months: {} };
}

let _writing = Promise.resolve();
function saveDB(db) {
  _writing = _writing.then(() => new Promise((resolve) => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
      if (err) { console.error('Erro ao gravar:', err); return resolve(); }
      fs.rename(tmp, DB_FILE, () => resolve());
    });
  }));
  return _writing;
}

let DB = loadDB();

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'trocar-este-token';

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || '';
  if (token && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'nao autorizado' });
}

app.post('/api/check-admin', (req, res) => {
  const token = (req.body && req.body.token) || '';
  res.json({ admin: !!token && token === ADMIN_TOKEN });
});

app.get('/api/state', (req, res) => {
  res.json({ state: DB.state, updated_at: DB.state_updated_at });
});

app.put('/api/state', requireAdmin, async (req, res) => {
  const state = req.body && req.body.state;
  if (!state || typeof state !== 'object') return res.status(400).json({ error: 'state invalido' });
  DB.state = state;
  DB.state_updated_at = new Date().toISOString();
  await saveDB(DB);
  res.json({ ok: true, updated_at: DB.state_updated_at });
});

app.get('/api/months', (req, res) => {
  const months = Object.keys(DB.months || {}).map(mes => ({
    mes, updated_at: DB.months[mes].updated_at
