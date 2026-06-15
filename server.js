const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '4mb' }));

// ────────────────────────────────────────────────
// Persistência em arquivo JSON (sem dependências nativas)
// No Railway, aponte um Volume para a pasta /data (DATA_DIR=/data)
// ────────────────────────────────────────────────
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
  // grava de forma atômica (temp + rename) e serializa as escritas
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

// ────────────────────────────────────────────────
// Token de admin (quem pode salvar/editar)
// Defina ADMIN_TOKEN nas variáveis do Railway.
// ────────────────────────────────────────────────
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'trocar-este-token';

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || '';
  if (token && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'nao autorizado' });
}

// ────────────────────────────────────────────────
// API
// ────────────────────────────────────────────────
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
  })).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  res.json({ months });
});

app.get('/api/months/:mes', (req, res) => {
  const m = DB.months && DB.months[req.params.mes];
  if (!m) return res.status(404).json({ error: 'mes nao encontrado' });
  res.json({ mes: req.params.mes, snapshot: m.snapshot, updated_at: m.updated_at });
});

app.put('/api/months/:mes', requireAdmin, async (req, res) => {
  const mes = req.params.mes;
  const snapshot = req.body && req.body.snapshot;
  if (!mes || !snapshot) return res.status(400).json({ error: 'dados invalidos' });
  DB.months = DB.months || {};
  DB.months[mes] = { snapshot, updated_at: new Date().toISOString() };
  await saveDB(DB);
  res.json({ ok: true, mes, updated_at: DB.months[mes].updated_at });
});

app.delete('/api/months/:mes', requireAdmin, async (req, res) => {
  if (DB.months) delete DB.months[req.params.mes];
  await saveDB(DB);
  res.json({ ok: true });
});

// ────────────────────────────────────────────────
// Arquivos estáticos (o dashboard)
// ────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
