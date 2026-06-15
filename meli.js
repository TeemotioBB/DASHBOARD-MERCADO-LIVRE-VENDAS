// ════════════════════════════════════════════════════════════
// meli.js — Integração com a API do Mercado Livre
// ════════════════════════════════════════════════════════════
// Este módulo cuida de:
//  1. Gerar o link de autorização (OAuth) para cada loja
//  2. Trocar o "code" por tokens (access_token + refresh_token)
//  3. Renovar o access_token automaticamente quando expira
//  4. Buscar os dados de cada loja (faturamento, anúncios, etc.)
//
// IMPORTANTE: os tokens são guardados pelo server.js (no db.json),
// este módulo só recebe e devolve os dados.
// ════════════════════════════════════════════════════════════

const API = 'https://api.mercadolibre.com';

// As 3 lojas. O "key" é usado internamente (rj/bh/es).
// O label é só para exibição.
const LOJAS = [
  { key: 'rj', label: 'Meli RJ' },
  { key: 'bh', label: 'Meli BH' },
  { key: 'es', label: 'Meli ES' },
];

// ── 1. Link de autorização ──────────────────────────────────
// O usuário (loja) abre este link, faz login no ML e autoriza.
// O ML redireciona de volta para redirectUri com ?code=...&state=<key>
function buildAuthUrl(clientId, redirectUri, lojaKey) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: lojaKey,           // usamos o state para saber qual loja autorizou
  });
  // Domínio br para contas do Brasil
  return `https://auth.mercadolivre.com.br/authorization?${params.toString()}`;
}

// ── 2. Trocar code por tokens ───────────────────────────────
async function exchangeCodeForTokens({ clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Falha ao obter token: ' + JSON.stringify(data));
  return data; // { access_token, refresh_token, expires_in, user_id, ... }
}

// ── 3. Renovar access_token usando o refresh_token ──────────
// Lembrete: o refresh_token é de uso único; a resposta traz um NOVO
// refresh_token que precisa ser salvo no lugar do antigo.
async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  const r = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Falha ao renovar token: ' + JSON.stringify(data));
  return data; // { access_token, refresh_token, expires_in, ... }
}

// Garante um access_token válido para uma loja.
// `tokenStore` é o objeto salvo: { access_token, refresh_token, expires_at, user_id }
// Devolve { token, updatedStore } — updatedStore != null se renovou (server salva).
async function ensureValidToken(tokenStore, { clientId, clientSecret }) {
  if (!tokenStore || !tokenStore.refresh_token) {
    throw new Error('Loja não autorizada');
  }
  const agora = Date.now();
  // margem de 5 min antes de expirar
  const valido = tokenStore.access_token && tokenStore.expires_at && (tokenStore.expires_at - agora > 5 * 60 * 1000);
  if (valido) {
    return { token: tokenStore.access_token, updatedStore: null };
  }
  // precisa renovar
  const data = await refreshAccessToken({ clientId, clientSecret, refreshToken: tokenStore.refresh_token });
  const updatedStore = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokenStore.refresh_token,
    expires_at: agora + (data.expires_in || 21600) * 1000,
    user_id: data.user_id || tokenStore.user_id,
  };
  return { token: updatedStore.access_token, updatedStore };
}

// Helper de chamada autenticada
async function apiGet(path, token) {
  const r = await fetch(`${API}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`GET ${path} falhou: ${JSON.stringify(data)}`);
  return data;
}

// ── 4. Buscar dados de uma loja ─────────────────────────────
// Recebe o token já válido e o user_id. Busca em camadas:
// faturamento (orders), anúncios/reputação (users+items).
// Retorna um objeto parcial para o mês corrente.
//
// `desde` e `ate` são datas ISO (ex: '2026-06-01T00:00:00.000-03:00')
async function fetchLojaData({ token, userId, desde, ate }) {
  const out = {
    faturamentoTotal: 0,
    porDia: {},          // { '2026-06-01': 1234.56, ... }
    pedidos: 0,
    reputacao: null,
    nivel: null,
    anunciosAtivos: null,
  };

  // ── 4a. FATURAMENTO via /orders/search ──
  // Paginamos os pedidos pagos do período.
  let offset = 0;
  const limit = 50;
  let total = Infinity;
  while (offset < total) {
    const path = `/orders/search?seller=${userId}`
      + `&order.status=paid`
      + `&order.date_created.from=${encodeURIComponent(desde)}`
      + `&order.date_created.to=${encodeURIComponent(ate)}`
      + `&offset=${offset}&limit=${limit}&sort=date_asc`;
    const page = await apiGet(path, token);
    total = (page.paging && page.paging.total) || 0;
    const results = page.results || [];
    for (const o of results) {
      const valor = o.total_amount || 0;
      out.faturamentoTotal += valor;
      out.pedidos += 1;
      const dia = (o.date_created || '').slice(0, 10); // YYYY-MM-DD
      if (dia) out.porDia[dia] = (out.porDia[dia] || 0) + valor;
    }
    if (results.length === 0) break;
    offset += limit;
    if (offset > 5000) break; // trava de segurança
  }

  // ── 4b. REPUTAÇÃO / NÍVEL via /users/{id} ──
  try {
    const u = await apiGet(`/users/${userId}`, token);
    if (u.seller_reputation) {
      out.nivel = u.seller_reputation.level_id || null;          // ex: '5_green'
      out.reputacao = u.seller_reputation.power_seller_status || null; // gold/platinum/...
    }
  } catch (e) { /* segue sem reputação */ }

  // ── 4c. ANÚNCIOS ATIVOS via /users/{id}/items/search ──
  try {
    const it = await apiGet(`/users/${userId}/items/search?status=active&limit=1`, token);
    out.anunciosAtivos = (it.paging && it.paging.total) || null;
  } catch (e) { /* segue sem contagem */ }

  return out;
}

module.exports = {
  LOJAS,
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  ensureValidToken,
  fetchLojaData,
};
