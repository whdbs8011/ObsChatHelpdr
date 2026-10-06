const API = 'https://openapi.chzzk.naver.com';
const LOCAL = 'http://localhost:18765';
const encoder = new TextEncoder();
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
function base64(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unbase64(value) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)); }
export async function digest(value) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }
async function encryptionKey(env) {
  const raw = unbase64(env.TOKEN_ENCRYPTION_KEY || '');
  if (raw.length !== 32) throw new Error('CONFIG');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode('stream-dock-auth-v1') }, await encryptionKey(env), encoder.encode(JSON.stringify(value)));
  return base64(iv) + '.' + base64(new Uint8Array(encrypted));
}
export async function unseal(value, env) {
  const [iv, cipher] = value.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode('stream-dock-auth-v1') }, await encryptionKey(env), unbase64(cipher));
  return JSON.parse(new TextDecoder().decode(plain));
}
const headers = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } }); }
function redirect(url, cookie) { return new Response(null, { status: 303, headers: { ...headers, Location: url, ...(cookie ? { 'Set-Cookie': cookie } : {}) } }); }
class PublicError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
async function bodyOf(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new PublicError('JSON 요청이 필요합니다.', 415);
  const reader = request.body?.getReader(); let length = 0; const chunks = [];
  if (!reader) return {};
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 4096) { await reader.cancel(); throw new PublicError('입력값이 너무 큽니다.', 413); } chunks.push(part.value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PublicError('JSON 형식이 올바르지 않습니다.'); }
}
async function api(env, path, method = 'POST', body, auth) {
  const response = await (env.UPSTREAM_FETCH || fetch)(API + path, {
    method, headers: { 'Content-Type': 'application/json', ...(auth === 'client' ? { 'Client-Id': env.CHZZK_CLIENT_ID, 'Client-Secret': env.CHZZK_CLIENT_SECRET } : auth ? { Authorization: 'Bearer ' + auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000)
  });
  let value; try { value = await response.json(); } catch { throw new PublicError('치지직 서버 응답 오류', 502); }
  if (!response.ok || (value.code && Number(value.code) !== 200)) throw new PublicError(response.status === 401 ? '인증이 만료됐습니다. 다시 로그인하세요.' : '치지직 인증 요청이 실패했습니다. 권한과 앱 설정을 확인하세요.', response.status === 401 ? 401 : 502);
  return value.content ?? value;
}
function tokenData(value) {
  if (!value.accessToken || !value.refreshToken) throw new PublicError('치지직 인증 정보를 받지 못했습니다.', 502);
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: Date.now() + Number(value.expiresIn || 86400) * 1000 };
}
function stmt(env, sql, ...values) { return env.DB.prepare(sql).bind(...values); }
async function sessionOf(request, env) {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!bearer) throw new PublicError('로그인이 필요합니다.', 401);
  const row = await stmt(env, 'SELECT * FROM sessions WHERE token_hash = ? AND expires > ?', await digest(bearer), Date.now()).first();
  if (!row) throw new PublicError('로그인이 만료됐습니다. 다시 로그인하세요.', 401);
  return row;
}
async function accessFor(row, env) {
  let token = await unseal(row.token_blob, env);
  if (token.expiresAt > Date.now() + 60000) return token;
  const lock = random(), now = Date.now();
  const locked = await stmt(env, 'UPDATE sessions SET refresh_lock = ?, lock_until = ? WHERE id = ? AND lock_until < ? RETURNING id', lock, now + 30000, row.id, now).first();
  if (!locked) throw new PublicError('로그인 갱신 중입니다. 잠시 후 다시 시도하세요.', 409);
  try {
    // Reload after acquiring the lock; another completed refresh may have rotated the token.
    const current = await stmt(env, 'SELECT * FROM sessions WHERE id = ?', row.id).first();
    token = await unseal(current.token_blob, env);
    if (token.expiresAt <= Date.now() + 60000) token = tokenData(await api(env, '/auth/v1/token', 'POST', { grantType: 'refresh_token', clientId: env.CHZZK_CLIENT_ID, clientSecret: env.CHZZK_CLIENT_SECRET, refreshToken: token.refreshToken }));
    await stmt(env, 'UPDATE sessions SET token_blob = ?, expires = ?, refresh_lock = NULL, lock_until = 0 WHERE id = ? AND refresh_lock = ?', await seal(token, env), Date.now() + 29 * 86400000, row.id, lock).run();
    return token;
  } catch (error) {
    await stmt(env, 'UPDATE sessions SET refresh_lock = NULL, lock_until = 0 WHERE id = ? AND refresh_lock = ?', row.id, lock).run();
    throw error;
  }
}
export async function handle(request, env) {
  try {
    const url = new URL(request.url), path = url.pathname;
    if (path === '/health' && request.method === 'GET') return json({ ok: true, service: 'stream-dock-auth', version: 1 });
    if (!env.CHZZK_CLIENT_ID || !env.CHZZK_CLIENT_SECRET || !env.TOKEN_ENCRYPTION_KEY || !env.DB) throw new PublicError('로그인 서버 설정을 완료해야 합니다.', 503);
    // Browser cross-origin fetch is never supported; local Node performs JSON requests.
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) throw new PublicError('허용되지 않은 요청입니다.', 403);
    const now = Date.now();
    if (path === '/login/start' && request.method === 'POST') {
      const input = await bodyOf(request);
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.challenge || '') || !/^[a-f0-9]{64}$/.test(input.localState || '')) throw new PublicError('로그인 요청 형식이 올바르지 않습니다.');
      await env.DB.batch([stmt(env, 'DELETE FROM login_requests WHERE expires < ?', now), stmt(env, 'DELETE FROM sessions WHERE expires < ?', now)]);
      const count = await stmt(env, 'SELECT COUNT(*) AS count FROM login_requests').first();
      if (count.count >= 30) throw new PublicError('로그인 요청이 많습니다. 잠시 후 다시 시도하세요.', 429);
      const id = random();
      await stmt(env, 'INSERT INTO login_requests (id, challenge, local_state, expires) VALUES (?, ?, ?, ?)', id, input.challenge, input.localState, now + 600000).run();
      return json({ url: url.origin + '/authorize?id=' + id });
    }
    if (path === '/authorize' && request.method === 'GET') {
      const id = url.searchParams.get('id'), browser = random();
      const row = await stmt(env, "UPDATE login_requests SET browser_hash = ?, status = 'authorizing' WHERE id = ? AND status = 'pending' AND expires > ? RETURNING id", await digest(browser), id, now).first();
      if (!row) throw new PublicError('로그인 링크가 만료되었거나 이미 사용됐습니다. 프로그램에서 다시 로그인하세요.');
      const auth = new URL('https://chzzk.naver.com/account-interlock');
      auth.search = new URLSearchParams({ clientId: env.CHZZK_CLIENT_ID, redirectUri: url.origin + '/callback', state: id });
      return redirect(auth.href, `dock_oauth_${id}=${browser}; Path=/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    }
    if (path === '/callback' && request.method === 'GET') {
      const id = url.searchParams.get('state'), code = url.searchParams.get('code');
      if (!/^[A-Za-z0-9_-]{43}$/.test(id || '') || !code) throw new PublicError('로그인이 취소됐거나 올바르지 않습니다.');
      const browser = request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('dock_oauth_' + id + '='))?.split('=')[1];
      if (!browser) throw new PublicError('로그인을 시작한 브라우저에서 다시 시도하세요.');
      const row = await stmt(env, "UPDATE login_requests SET status = 'completing' WHERE id = ? AND status = 'authorizing' AND browser_hash = ? AND expires > ? RETURNING *", id, await digest(browser), now).first();
      if (!row) throw new PublicError('로그인 요청이 만료되었거나 이미 처리됐습니다.');
      try {
        const token = tokenData(await api(env, '/auth/v1/token', 'POST', { grantType: 'authorization_code', clientId: env.CHZZK_CLIENT_ID, clientSecret: env.CHZZK_CLIENT_SECRET, code, state: id }));
        await stmt(env, "UPDATE login_requests SET status = 'ready', token_blob = ?, expires = ? WHERE id = ?", await seal(token, env), now + 120000, id).run();
        return redirect(LOCAL + '/auth/broker-callback#' + new URLSearchParams({ handoff: id, state: row.local_state }), `dock_oauth_${id}=; Path=/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      } catch (error) { await stmt(env, 'DELETE FROM login_requests WHERE id = ?', id).run(); throw error; }
    }
    if (path === '/login/redeem' && request.method === 'POST') {
      const input = await bodyOf(request);
      if (!/^[A-Za-z0-9_-]{43}$/.test(input.verifier || '') || !/^[A-Za-z0-9_-]{43}$/.test(input.handoff || '')) throw new PublicError('로그인 연결 정보가 올바르지 않습니다.');
      const row = await stmt(env, "UPDATE login_requests SET status = 'redeemed' WHERE id = ? AND challenge = ? AND status = 'ready' AND expires > ? RETURNING *", input.handoff, await digest(input.verifier), now).first();
      if (!row) throw new PublicError('로그인 연결이 만료되었거나 이미 사용됐습니다.');
      const token = await unseal(row.token_blob, env), deviceToken = random(), sessionId = random();
      const max = Math.min(10, Math.max(1, Number(env.MAX_SESSIONS) || 10));
      const created = await stmt(env, 'INSERT INTO sessions (id, token_hash, token_blob, expires) SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM sessions WHERE expires > ?) < ? RETURNING id', sessionId, await digest(deviceToken), await seal(token, env), now + 29 * 86400000, now, max).first();
      await stmt(env, 'DELETE FROM login_requests WHERE id = ?', row.id).run();
      if (!created) throw new PublicError('최대 10개의 연결을 지원합니다. 사용하지 않는 PC에서 로그아웃하세요.', 429);
      return json({ deviceToken, accessToken: token.accessToken, expiresAt: token.expiresAt });
    }
    if (path === '/session/token' && request.method === 'POST') {
      const row = await sessionOf(request, env); const token = await accessFor(row, env);
      return json({ accessToken: token.accessToken, expiresAt: token.expiresAt });
    }
    if (path === '/session/logout' && request.method === 'POST') {
      const row = await sessionOf(request, env), token = await unseal(row.token_blob, env);
      try { await api(env, '/auth/v1/token/revoke', 'POST', { clientId: env.CHZZK_CLIENT_ID, clientSecret: env.CHZZK_CLIENT_SECRET, token: token.accessToken, tokenTypeHint: 'access_token' }); }
      finally { await stmt(env, 'DELETE FROM sessions WHERE id = ?', row.id).run(); }
      return json({ ok: true });
    }
    if (path === '/categories' && request.method === 'GET') {
      await sessionOf(request, env);
      const query = url.searchParams.get('query')?.trim();
      if (!query || query.length > 100) throw new PublicError('검색어를 입력하세요.');
      return json(await api(env, '/open/v1/categories/search?' + new URLSearchParams({ query, size: '30' }), 'GET', undefined, 'client'));
    }
    return json({ error: '페이지를 찾을 수 없습니다.' }, 404);
  } catch (error) { return json({ error: error instanceof PublicError ? error.message : '로그인 서버 오류입니다. 잠시 후 다시 시도하세요.' }, error instanceof PublicError ? error.status : 500); }
}
export default { fetch: handle };
