import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handle, digest, seal, unseal } from './worker.mjs';

function fixture() {
  const database = new DatabaseSync(':memory:'); database.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const calls = [], env = { CHZZK_CLIENT_ID: 'test-id', CHZZK_CLIENT_SECRET: 'test-secret', TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url'), MAX_SESSIONS: '10' };
  env.DB = { prepare(sql) {
    return { bind(...values) { return { first: async () => database.prepare(sql).get(...values) || null, run: async () => database.prepare(sql).run(...values) }; } };
  }, batch: async statements => { database.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); database.exec('COMMIT'); return results; } catch (error) { database.exec('ROLLBACK'); throw error; } } };
  env.UPSTREAM_FETCH = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, ...options, body });
    if (url.endsWith('/auth/v1/token')) return Response.json({ code: 200, content: { accessToken: body.grantType === 'refresh_token' ? 'refreshed-access' : 'fake-access', refreshToken: 'fake-refresh', expiresIn: 86400 } });
    return Response.json({ code: 200, content: { data: [{ categoryValue: '마인크래프트' }] } });
  };
  const request = (path, body, extra = {}) => handle(new Request('https://auth.example' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { database, env, calls, request };
}
test('Tokens are encrypted and tampering is rejected', async () => {
  const { database, env } = fixture();
  const cipher = await seal({ secret: 'plaintext-test' }, env);
  assert.equal(cipher.includes('plaintext-test'), false); assert.deepEqual(await unseal(cipher, env), { secret: 'plaintext-test' });
  await assert.rejects(() => unseal(cipher.slice(0, -3) + 'AAA', env)); database.close();
});
test('Complete login, browser binding, proof of possession, one-time redeem, refresh and logout', async () => {
  const { database, env, calls, request } = fixture();
  const verifier = 'V'.repeat(43), localState = 'a'.repeat(64), challenge = await digest(verifier);
  assert.equal((await request('/login/start', { challenge, localState }, { Origin: 'https://evil.example' })).status, 403);
  const start = await (await request('/login/start', { challenge, localState })).json();
  const authorize = await request(new URL(start.url).pathname + new URL(start.url).search);
  const id = new URL(authorize.headers.get('Location')).searchParams.get('state');
  assert.equal(new URL(authorize.headers.get('Location')).searchParams.get('redirectUri'), 'https://auth.example/callback');
  const cookie = authorize.headers.get('Set-Cookie').split(';')[0];
  assert.equal((await request('/callback?code=test&state=' + id)).status, 400);
  const callback = await request('/callback?code=test&state=' + id, undefined, { Cookie: cookie });
  assert.equal(callback.status, 303);
  const landing = new URL(callback.headers.get('Location'));
  assert.equal(landing.origin, 'http://localhost:18765'); assert.equal(landing.search, ''); assert.equal(landing.href.includes('fake-access'), false);
  assert.equal((await request('/callback?code=test&state=' + id, undefined, { Cookie: cookie })).status, 400);
  assert.equal((await request('/login/redeem', { handoff: id, verifier: 'X'.repeat(43) })).status, 400);
  const redeem = await request('/login/redeem', { handoff: id, verifier }); assert.equal(redeem.status, 200);
  const result = await redeem.json(); assert.equal(result.accessToken, 'fake-access'); assert.equal(result.refreshToken, undefined); assert.equal(result.clientSecret, undefined);
  assert.equal((await request('/login/redeem', { handoff: id, verifier })).status, 400);
  const headers = { Authorization: 'Bearer ' + result.deviceToken };
  assert.equal((await request('/session/token', {})).status, 401);
  assert.equal((await (await request('/session/token', {}, headers)).json()).accessToken, 'fake-access');
  const row = database.prepare('SELECT * FROM sessions').get();
  assert.notEqual(row.token_hash, result.deviceToken); assert.equal(row.token_blob.includes('fake-refresh'), false);
  const token = await unseal(row.token_blob, env); token.expiresAt = Date.now() - 1000;
  database.prepare('UPDATE sessions SET token_blob = ?').run(await seal(token, env));
  assert.equal((await (await request('/session/token', {}, headers)).json()).accessToken, 'refreshed-access');
  assert.equal((await request('/categories?query=minecraft', undefined, headers)).status, 200);
  const category = calls.find(call => call.url.includes('/categories/search')); assert.equal(category.headers['Client-Secret'], 'test-secret');
  assert.equal((await request('/session/logout', {}, headers)).status, 200);
  assert.equal((await request('/session/token', {}, headers)).status, 401);
  database.close();
});
test('Login expiry and active-session cap are enforced', async () => {
  const { database, env, request } = fixture();
  const verifier = 'V'.repeat(43), id = 'I'.repeat(43), tokenBlob = await seal({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 100000 }, env);
  for (let i = 0; i < 10; i++) database.prepare('INSERT INTO sessions(id,token_hash,token_blob,expires) VALUES(?,?,?,?)').run('session-' + i, 'hash-' + i, tokenBlob, Date.now() + 100000);
  database.prepare('INSERT INTO login_requests(id,challenge,local_state,status,token_blob,expires) VALUES(?,?,?,?,?,?)').run(id, await digest(verifier), 's', 'ready', tokenBlob, Date.now() + 10000);
  assert.equal((await request('/login/redeem', { handoff: id, verifier })).status, 429);
  database.prepare('INSERT INTO login_requests(id,challenge,local_state,status,token_blob,expires) VALUES(?,?,?,?,?,?)').run('E'.repeat(43), await digest(verifier), 's', 'ready', tokenBlob, Date.now() - 10000);
  assert.equal((await request('/login/redeem', { handoff: 'E'.repeat(43), verifier })).status, 400);
  database.close();
});
