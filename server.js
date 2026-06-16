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

// Sincronizar: busca dados das 3 lojas para um período e devolve consolidado.
// LIBERADO para qualquer visitante: apenas LÊ da API do ML e devolve os números.
// Não grava nada no servidor (só o admin salva via /api/state).
// Body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
app.post('/api/meli/sync', async (req, res) => {
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

// Curva ABC + itens sem estoque. Busca 90 dias (ou período enviado) das 3 lojas,
// consolida por item, classifica A/B/C por faturamento (Pareto) e devolve os itens.
// LIBERADO para visitantes (só lê da API). É pesado: usar sob demanda (botão).
// Body opcional: { dias: 90 }
app.post('/api/meli/curva', async (req, res) => {
  if (!mlConfigured()) return res.status(400).json({ error: 'Integração não configurada' });
  const dias = Math.min(Math.max(parseInt((req.body && req.body.dias) || 90, 10) || 90, 7), 365);

  // período: hoje - dias  até  agora (fuso de Brasília)
  const fmt = (d) => {
    const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${day}`;
  };
  const hoje = new Date();
  const ini = new Date(hoje.getTime() - dias*24*60*60*1000);
  const desde = `${fmt(ini)}T00:00:00.000-03:00`;
  const ate   = `${fmt(hoje)}T23:59:59.000-03:00`;

  // 1) Coleta de cada loja: VENDAS (no período) e ESTOQUE de todos os ativos.
  // Buscar o estoque de todos os anúncios ativos (não só os que venderam) é o que
  // permite o alerta de transferência: saber que um item zerado numa loja tem
  // estoque parado em outra.
  const erros = {};
  const itensConsolidados = {};  // chave -> item consolidado entre lojas
  // guarda o estoque por loja indexado por chave (sku/id), mesmo sem venda
  const estoquePorLojaChave = {}; // { 'rj': { 'sku:123': {estoque, id, status, title} }, ... }

  function chaveDe(sku, id){ return sku ? `sku:${sku}` : `id:${id}`; }

  for (const l of meli.LOJAS) {
    const store = DB.tokens[l.key];
    if (!store || !store.refresh_token) { erros[l.key] = 'não conectada'; continue; }
    try {
      const { token, updatedStore } = await meli.ensureValidToken(store, { clientId: ML_CLIENT_ID, clientSecret: ML_CLIENT_SECRET });
      if (updatedStore) { DB.tokens[l.key] = updatedStore; await saveDB(DB); }
      const userId = DB.tokens[l.key].user_id;

      // 1a. Estoque de TODOS os anúncios ativos desta loja
      estoquePorLojaChave[l.key] = {};
      try {
        const ativos = await meli.fetchEstoqueAtivos({ token, userId });
        for (const a of ativos) {
          const k = chaveDe(a.sku, a.id);
          // se houver mais de um anúncio do mesmo SKU na loja, soma o estoque
          const prev = estoquePorLojaChave[l.key][k];
          estoquePorLojaChave[l.key][k] = {
            estoque: (prev ? (prev.estoque||0) : 0) + (a.estoque!=null ? a.estoque : 0),
            estoqueConhecido: true,
            id: a.id, status: a.status, title: a.title, sku: a.sku,
          };
        }
      } catch (e) { /* segue só com o estoque dos que venderam */ }

      // 1b. Vendas no período
      const { itens } = await meli.fetchCurvaABC({ token, userId, desde, ate });
      for (const it of itens) {
        const chave = chaveDe(it.sku, it.id);
        if (!itensConsolidados[chave]) {
          itensConsolidados[chave] = {
            chave, sku: it.sku, title: it.title,
            unidades: 0, faturamento: 0,
            estoque: 0, estoqueConhecido: false,
            porLoja: {},
          };
        }
        const c = itensConsolidados[chave];
        c.unidades += it.unidades || 0;
        c.faturamento += it.faturamento || 0;
        if (!c.porLoja[l.key]) c.porLoja[l.key] = { unidades:0, faturamento:0, estoque:null, id:it.id, status:it.status||null };
        c.porLoja[l.key].unidades += it.unidades || 0;
        c.porLoja[l.key].faturamento += it.faturamento || 0;
        c.porLoja[l.key].id = it.id;
      }
    } catch (e) {
      erros[l.key] = e.message;
    }
  }

  // 1c. Mescla o estoque (de todos os ativos) em cada item consolidado, por loja.
  // Garante que o estoque de uma loja entre na conta mesmo sem venda no período.
  for (const chave of Object.keys(itensConsolidados)) {
    const c = itensConsolidados[chave];
    c.estoque = 0; c.estoqueConhecido = false;
    for (const l of meli.LOJAS) {
      const est = estoquePorLojaChave[l.key] && estoquePorLojaChave[l.key][chave];
      if (est) {
        if (!c.porLoja[l.key]) c.porLoja[l.key] = { unidades:0, faturamento:0, id:est.id, status:est.status };
        c.porLoja[l.key].estoque = est.estoque;
        c.estoque += est.estoque;
        c.estoqueConhecido = true;
        if (!c.sku && est.sku) c.sku = est.sku;
        if (!c.title && est.title) c.title = est.title;
      } else if (c.porLoja[l.key] && c.porLoja[l.key].estoque == null) {
        // vendeu nessa loja mas não achamos entre os ativos (anúncio pausado/encerrado)
        c.porLoja[l.key].estoque = 0;
      }
    }
  }

  // 2) Classificação ABC HÍBRIDA via Pareto acumulado.
  // Calcula DUAS curvas — uma por giro (unidades) e outra por faturamento — e
  // atribui a cada item a MELHOR das duas. Assim, tanto um item de alto giro
  // (ex.: reservatório, 131 un) quanto um de alta receita mas poucas vendas
  // (ex.: lanterna cara, 2 un) ficam em A. Só cai em C quem é irrelevante nos dois.
  let lista = Object.values(itensConsolidados);
  const fatTotal = lista.reduce((s,it)=>s+it.faturamento, 0) || 1;
  const unidTotal = lista.reduce((s,it)=>s+(it.unidades||0), 0) || 1;

  // Função genérica: classifica a lista por um "valor" via Pareto e grava em campoCurva
  function classificarPareto(valorDe, total, campoCurva){
    const ordenada = lista.slice().sort((a,b)=> valorDe(b) - valorDe(a));
    let acum = 0;
    for (const it of ordenada) {
      const pctAntes = acum / total;
      acum += valorDe(it);
      it[campoCurva] = pctAntes < 0.80 ? 'A' : (pctAntes < 0.95 ? 'B' : 'C');
    }
  }
  classificarPareto(it=> it.unidades||0, unidTotal, 'curvaGiro');
  classificarPareto(it=> it.faturamento||0, fatTotal, 'curvaFat');

  // Curva final = melhor (mais alta) entre giro e faturamento
  const rank = { A:3, B:2, C:1 };
  for (const it of lista) {
    it.curva = rank[it.curvaGiro] >= rank[it.curvaFat] ? it.curvaGiro : it.curvaFat;
    // motivo da classificação (ajuda a entender por que é A)
    if (it.curva === 'A') {
      it.motivoCurva = (it.curvaGiro==='A' && it.curvaFat==='A') ? 'giro+receita'
                     : (it.curvaGiro==='A' ? 'giro' : 'receita');
    } else {
      it.motivoCurva = null;
    }
    it.pctFaturamento = it.faturamento / fatTotal;
    it.pctUnidades = (it.unidades || 0) / unidTotal;
    it.vendaMediaDia = (it.unidades || 0) / dias;       // unidades/dia
    it.fatMediaDia = (it.faturamento || 0) / dias;      // R$/dia
    // Cobertura: dias até o estoque zerar no ritmo de venda atual.
    if (!it.estoqueConhecido) {
      it.coberturaDias = null;
    } else if (it.vendaMediaDia > 0) {
      it.coberturaDias = it.estoque / it.vendaMediaDia;
    } else {
      it.coberturaDias = Infinity;   // tem estoque mas não vende → não zera
    }
    if (it.estoqueConhecido && it.estoque <= 0) it.alerta = 'zerado';
    else if (it.coberturaDias != null && it.coberturaDias <= 7) it.alerta = 'critico';
    else if (it.coberturaDias != null && it.coberturaDias <= 15) it.alerta = 'atencao';
    else it.alerta = 'ok';
  }

  const lojaLabel = {}; meli.LOJAS.forEach(l=>lojaLabel[l.key]=l.label);

  // Anexa, a cada item, a análise de estoque por loja:
  //  - lojasZeradas: lojas onde o item está ativo/vendendo mas com estoque 0
  //  - lojasComEstoque: lojas que têm estoque (candidatas a transferir)
  //  - transferencia: sugestão "de X para Y" quando uma loja tem e outra zerou
  for (const it of lista) {
    const zeradas = [];
    const comEstoque = [];
    for (const k of Object.keys(it.porLoja||{})) {
      const pl = it.porLoja[k];
      const temVenda = (pl.unidades||0) > 0;
      const est = (pl.estoque!=null) ? pl.estoque : null;
      if (est != null && est > 0) comEstoque.push({ loja:k, label:lojaLabel[k]||k, estoque:est, vendeu:temVenda });
      else if (est != null && est <= 0) zeradas.push({ loja:k, label:lojaLabel[k]||k, vendeu:temVenda });
    }
    it.lojasZeradas = zeradas;
    it.lojasComEstoque = comEstoque;
    // Há oportunidade de transferência se alguma loja zerou E outra tem estoque
    it.transferencia = (zeradas.length > 0 && comEstoque.length > 0)
      ? { de: comEstoque.slice().sort((a,b)=>b.estoque-a.estoque), para: zeradas }
      : null;
  }

  // 3) Subconjunto: Curva A e B com ALGUMA loja zerada (precisa repor naquela loja).
  // Inclui tanto "zerado em todas" (comprar) quanto "zerado em uma, com estoque em
  // outra" (transferir) — o frontend diferencia pelos campos de transferência.
  const curvaAsemEstoque = lista
    .filter(it => (it.curva === 'A' || it.curva === 'B')
                && it.estoqueConhecido
                && (it.lojasZeradas && it.lojasZeradas.length > 0))
    .sort((a,b)=> {
      // A antes de B; depois quem pode transferir (ação mais barata) sobe;
      // por fim, maior giro primeiro
      if (a.curva !== b.curva) return a.curva === 'A' ? -1 : 1;
      const at = a.transferencia ? 1 : 0, bt = b.transferencia ? 1 : 0;
      if (at !== bt) return bt - at;
      return b.vendaMediaDia - a.vendaMediaDia;
    });

  // 3b) Itens ZERANDO: Curva A ou B, com estoque > 0 e cobertura <= 15 dias.
  // Ordena por urgência: menor cobertura primeiro; empate, quem mais vende/dia.
  const itensZerando = lista
    .filter(it => (it.curva === 'A' || it.curva === 'B')
                && it.estoqueConhecido && it.estoque > 0
                && it.coberturaDias != null && it.coberturaDias <= 15)
    .sort((a,b)=> (a.coberturaDias - b.coberturaDias) || (b.vendaMediaDia - a.vendaMediaDia));

  DB.meli_curva_last = new Date().toISOString();

  const resultadoCurva = {
    periodo: { desde, ate, dias },
    last_curva: DB.meli_curva_last,
    totalItens: lista.length,
    faturamentoTotal: fatTotal,
    curvaAsemEstoque,
    itensZerando,
    erros,
  };

  // Persiste o último resultado no servidor, para que reapareça ao abrir o site
  // (sem precisar recalcular). Qualquer atualização sobrescreve o anterior.
  DB.meli_curva = resultadoCurva;
  await saveDB(DB);

  res.json({ ok: true, ...resultadoCurva });
});

// Lê o último resultado de curva salvo no servidor (para mostrar ao abrir o site)
app.get('/api/meli/curva', (req, res) => {
  if (DB.meli_curva) {
    res.json({ ok: true, persisted: true, ...DB.meli_curva });
  } else {
    res.json({ ok: true, persisted: false, vazio: true });
  }
});

// ──────────────────────────────────────────────
// Arquivos estáticos
// ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dashboard rodando na porta ${PORT}`));
