const express = require('express');
const path = require('path');
const fs = require('fs');
const meli = require('./meli');

const app = express();
app.use(express.json({ limit: '4mb' }));

// ──────────────────────────────────────────────
// Persistência em arquivo JSON
// ──────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.warn('Falha ao ler db.json:', e.message); }
  return { state: null, state_updated_at: null, months: {}, tokens: {}, meli_last_sync: null };
}

let _writing = Promise.resolve();
function saveDB(db) {
  _writing = _writing.then(() => new Promise((resolve, reject) => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(db, null, 2), (err) => {
      if (err) { console.error('[saveDB] ERRO ao gravar em', DB_FILE, '->', err.message); return reject(err); }
      fs.rename(tmp, DB_FILE, (err2) => {
        if (err2) { console.error('[saveDB] ERRO ao renomear ->', err2.message); return reject(err2); }
        resolve();
      });
    });
  }));
  return _writing;
}

let DB = loadDB();
if (!DB.tokens) DB.tokens = {};   // { rj:{access_token,refresh_token,expires_at,user_id}, ... }

// ──────────────────────────────────────────────
// Variáveis de ambiente (Railway → Variables)
// ──────────────────────────────────────────────
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN   || 'trocar-este-token';
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || '';
// URL pública do app no Railway, ex: https://seuapp.up.railway.app
const PUBLIC_URL    = process.env.PUBLIC_URL    || '';
const REDIRECT_URI  = (PUBLIC_URL ? PUBLIC_URL.replace(/\/$/, '') : '') + '/oauth/callback';

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || '';
  if (token && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'nao autorizado' });
}

function mlConfigured() {
  return !!(ML_CLIENT_ID && ML_CLIENT_SECRET && PUBLIC_URL);
}

// ══════════════════════════════════════════════
// API — Estado / Meses / Admin  (já existente)
// ══════════════════════════════════════════════
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

// ══════════════════════════════════════════════
// API — Mercado Livre
// ══════════════════════════════════════════════

// Diagnóstico: testa se o DATA_DIR é gravável e o que está salvo
app.get('/api/meli/diag', requireAdmin, (req, res) => {
  const info = { data_dir: DATA_DIR, db_file: DB_FILE };
  // teste de escrita real
  try {
    const probe = path.join(DATA_DIR, '.write-test');
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
    info.writable = true;
  } catch (e) {
    info.writable = false;
    info.write_error = e.message;
  }
  // db.json existe? que lojas tem token?
  info.db_exists = fs.existsSync(DB_FILE);
  info.tokens_em_memoria = Object.keys(DB.tokens || {});
  // mostra quais campos cada token tem (sem expor os valores)
  info.token_campos = {};
  for (const k of Object.keys(DB.tokens || {})) {
    const t = DB.tokens[k] || {};
    info.token_campos[k] = {
      tem_access_token: !!t.access_token,
      tem_refresh_token: !!t.refresh_token,
      tem_user_id: t.user_id != null,
      expira_em: t.expires_at ? new Date(t.expires_at).toISOString() : null,
    };
  }
  try {
    if (info.db_exists) {
      const disk = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      info.tokens_no_disco = Object.keys(disk.tokens || {});
    }
  } catch (e) { info.read_error = e.message; }
  // inclui o que a rota de status devolveria, para comparar
  info.status_lojas = meli.LOJAS.map(l => ({
    key: l.key,
    conectada: !!(DB.tokens[l.key] && DB.tokens[l.key].refresh_token),
    user_id: DB.tokens[l.key] ? DB.tokens[l.key].user_id : null,
  }));
  res.json(info);
});

// Status da integração: quais lojas estão conectadas
app.get('/api/meli/status', requireAdmin, (req, res) => {
  const configured = mlConfigured();
  const lojas = meli.LOJAS.map(l => ({
    key: l.key,
    label: l.label,
    conectada: !!(DB.tokens[l.key] && DB.tokens[l.key].refresh_token),
    user_id: DB.tokens[l.key] ? DB.tokens[l.key].user_id : null,
  }));
  res.json({
    configured,
    redirect_uri: REDIRECT_URI,
    last_sync: DB.meli_last_sync,
    lojas,
  });
});

// Gera o link de autorização para uma loja (admin abre num popup/nova aba)
app.get('/api/meli/connect/:loja', requireAdmin, (req, res) => {
  if (!mlConfigured()) return res.status(400).json({ error: 'Integração não configurada (faltam variáveis ML_*)' });
  const loja = req.params.loja;
  if (!meli.LOJAS.find(l => l.key === loja)) return res.status(400).json({ error: 'loja inválida' });
  const url = meli.buildAuthUrl(ML_CLIENT_ID, REDIRECT_URI, loja);
  res.json({ url });
});

// Callback do OAuth: o ML redireciona pra cá com ?code=...&state=<loja>
app.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  const loja = req.query.state;
  if (!code || !loja) return res.status(400).send('Faltam parâmetros code/state.');
  try {
    const data = await meli.exchangeCodeForTokens({
      clientId: ML_CLIENT_ID, clientSecret: ML_CLIENT_SECRET, code, redirectUri: REDIRECT_URI,
    });
    DB.tokens[loja] = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 21600) * 1000,
      user_id: data.user_id,
    };
    await saveDB(DB);
    console.log('[oauth] Loja', loja, 'conectada e salva. user_id=', data.user_id, 'em', DB_FILE);
    res.send(`<html><body style="font-family:sans-serif;background:#0d0f14;color:#E8EAF0;padding:40px">
      <h2>✓ Loja "${loja}" conectada com sucesso!</h2>
      <p>Pode fechar esta aba e voltar ao dashboard.</p>
      <script>setTimeout(()=>{ window.close(); }, 2000);</script>
    </body></html>`);
  } catch (e) {
    console.error('[oauth] FALHA ao conectar loja', loja, '->', e.message);
    res.status(500).send('Erro ao conectar: ' + e.message);
  }
});

// Desconectar uma loja
app.delete('/api/meli/connect/:loja', requireAdmin, async (req, res) => {
  delete DB.tokens[req.params.loja];
  await saveDB(DB);
  res.json({ ok: true });
});

// Sincronizar: busca dados das 3 lojas para um período e devolve consolidado
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
app.post('/api/meli/sync', requireAdmin, async (req, res) => {
  if (!mlConfigured()) return res.status(400).json({ error: 'Integração não configurada' });
  const from = (req.body && req.body.from) || '';
  const to   = (req.body && req.body.to)   || '';
  if (!from || !to) return res.status(400).json({ error: 'Informe from e to (YYYY-MM-DD)' });

  // datas ISO com fuso de Brasília
  const desde = `${from}T00:00:00.000-03:00`;
  const ate   = `${to}T23:59:59.000-03:00`;

  const resultado = { lojas: {}, erros: {} };
  for (const l of meli.LOJAS) {
    const store = DB.tokens[l.key];
    if (!store || !store.refresh_token) { resultado.erros[l.key] = 'não conectada'; continue; }
    try {
      const { token, updatedStore } = await meli.ensureValidToken(store, { clientId: ML_CLIENT_ID, clientSecret: ML_CLIENT_SECRET });
      if (updatedStore) { DB.tokens[l.key] = updatedStore; await saveDB(DB); }
      const dados = await meli.fetchLojaData({ token, userId: DB.tokens[l.key].user_id, desde, ate });
      resultado.lojas[l.key] = dados;
    } catch (e) {
      resultado.erros[l.key] = e.message;
    }
  }
  DB.meli_last_sync = new Date().toISOString();
  await saveDB(DB);
  res.json({ ok: true, last_sync: DB.meli_last_sync, ...resultado });
});

// ──────────────────────────────────────────────
// Arquivos estáticos
// ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
