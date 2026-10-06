import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectSocket } from './chat-socket.mjs';
import { createDeviceStore } from './device-store.mjs';

export const ORIGIN = 'http://localhost:18765';
const CALLBACK = ORIGIN + '/auth/callback';
const ROOT = new URL('./public/', import.meta.url);
const API = 'https://openapi.chzzk.naver.com';
const parseEvent = value => typeof value === 'string' ? JSON.parse(value) : value;
export function validState(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function messageBody(body) {
  if (typeof body.message !== 'string' || !body.message.trim() || [...body.message].length > 100) throw new Error('메시지는 1~100자로 입력하세요.');
  return { message: body.message };
}
export function createApp({ fetcher = fetch, socketFactory = connectSocket, brokerUrl = process.env.STREAM_DOCK_AUTH_URL || '', deviceStore = null } = {}) {
  if (brokerUrl) { const u = new URL(brokerUrl); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('로그인 서버 주소는 HTTPS 기본 주소여야 합니다.'); brokerUrl = u.origin; }
  let credentials = null, tokens = null, pending = null, socket = null, timer = null, refreshJob = null;
  let deviceToken = null;
  let feedStatus = '로그인이 필요합니다.', generation = 0, connecting = false;
  let channelId = null, receivedChats = 0, lastChatAt = null;
  const clients = new Set(), history = [];
  function emit(type, data) {
    const event = { type, data, time: Date.now() };
    if (['CHAT', 'DONATION', 'SUBSCRIPTION'].includes(type)) { history.push(event); if (history.length > 400) history.shift(); }
    for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  function status(text) { feedStatus = text; emit('STATUS', text); }
  async function broker(path, method = 'POST', body) {
    const response = await fetcher(brokerUrl + path, { method, headers: { 'Content-Type': 'application/json', ...(deviceToken ? { Authorization: 'Bearer ' + deviceToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '로그인 서버 요청 실패');
    return result;
  }
  async function upstream(path, method = 'GET', body, authenticated = true) {
    const response = await fetcher(API + path, {
      method, headers: { 'Content-Type': 'application/json', ...(authenticated === 'client' ? { 'Client-Id': credentials.clientId, 'Client-Secret': credentials.clientSecret } : authenticated ? { Authorization: 'Bearer ' + tokens.accessToken } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000)
    });
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('치지직 응답을 읽을 수 없습니다.'); }
    if (!response.ok || (data.code && Number(data.code) !== 200)) {
      const error = new Error(`치지직 요청 실패 (${response.status}): ${data.message || '권한과 입력값을 확인하세요.'}`);
      error.status = response.status; throw error;
    }
    return data.content ?? data;
  }
  function assignTokens(value) {
    if (!value.accessToken || (!brokerUrl && !value.refreshToken)) throw new Error('인증 토큰을 받지 못했습니다.');
    tokens = { ...value, expiresAt: value.expiresAt || Date.now() + Number(value.expiresIn || 86400) * 1000 };
  }
  async function refresh() {
    if (!refreshJob) refreshJob = (async () => {
      const old = tokens;
      const result = brokerUrl ? await broker('/session/token', 'POST', {}) : await upstream('/auth/v1/token', 'POST', { grantType: 'refresh_token', refreshToken: old.refreshToken, ...credentials }, false);
      if (tokens !== old) throw new Error('로그인 상태가 변경됐습니다.');
      assignTokens(result);
    })().finally(() => { refreshJob = null; });
    return refreshJob;
  }
  async function call(path, method, body) {
    if (!tokens) throw new Error('치지직에 먼저 로그인하세요.');
    if (Date.now() > tokens.expiresAt - 60000) await refresh();
    try { return await upstream(path, method, body); }
    catch (error) { if (error.status !== 401) throw error; await refresh(); return upstream(path, method, body); }
  }
  function stopFeed() {
    generation++; clearTimeout(timer); timer = null; connecting = false;
    if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  }
  async function connectFeed() {
    if (!tokens || connecting) return;
    stopFeed(); connecting = true; const epoch = generation;
    status('채팅에 연결 중…');
    try {
      const data = await call('/open/v1/sessions/auth');
      if (epoch !== generation) return;
      const url = new URL(data.url);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.naver.com')) throw new Error('올바르지 않은 채팅 서버 주소입니다.');
      socket = socketFactory(data.url, { reconnection: false, forceNew: true, timeout: 10000, transports: ['websocket'] });
      socket.on('SYSTEM', async raw => {
        try {
          const event = parseEvent(raw);
          if (epoch !== generation) return;
          if (event.type === 'connected') {
            connecting = false;
            status('채팅 수신 권한 확인 중…');
            const results = await Promise.allSettled(['chat', 'donation', 'subscription'].map(kind => call('/open/v1/sessions/events/subscribe/' + kind + '?sessionKey=' + encodeURIComponent(event.data.sessionKey), 'POST')));
            if (epoch !== generation) return;
            if (results[0].status === 'rejected') status('채팅 조회 권한을 확인하세요.');
            results.forEach((result, i) => { if (result.status === 'rejected') emit('ERROR', ['채팅', '후원', '구독'][i] + ': ' + result.reason.message); });
          }
          if (event.type === 'subscribed' && event.data?.eventType === 'CHAT') {
            channelId = event.data.channelId;
            status('채팅 연결됨'); emit('CONNECTION', { channelId, receivedChats, lastChatAt });
          }
          if (['revoked', 'unsubscribed'].includes(event.type) && event.data?.eventType === 'CHAT') {
            channelId = null; status('채팅 수신 권한이 해제되었습니다. 다시 로그인하세요.');
          }
        } catch (error) { emit('ERROR', error.message); }
      });
      for (const kind of ['CHAT', 'DONATION', 'SUBSCRIPTION']) socket.on(kind, raw => {
        try { if (epoch === generation) {
          const data = parseEvent(raw);
          if (kind === 'CHAT') { receivedChats++; lastChatAt = Date.now(); }
          emit(kind, data);
        } } catch { emit('ERROR', '채팅 이벤트 형식 오류'); }
      });
      const retry = () => {
        if (epoch !== generation) return;
        stopFeed(); status('연결이 끊겼습니다. 5초 후 재연결합니다.');
        timer = setTimeout(() => connectFeed(), 5000);
      };
      socket.on('disconnect', retry); socket.on('connect_error', retry);
    } catch (error) {
      if (epoch !== generation) return;
      connecting = false; status(error.message); timer = setTimeout(() => connectFeed(), 15000);
    }
  }
  async function bodyOf(req) {
    let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 16384) throw new Error('입력값이 너무 큽니다.'); }
    return raw ? JSON.parse(raw) : {};
  }
  const server = http.createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      if (req.headers.host !== 'localhost:18765') return send(403, { error: '허용되지 않은 주소입니다.' });
      const url = new URL(req.url, ORIGIN), path = url.pathname;
      if (req.method !== 'GET' && (req.headers.origin !== ORIGIN || req.headers['x-dock-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json'))) return send(403, { error: '허용되지 않은 요청입니다.' });
      if (path === '/auth/broker-callback' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(await readFile(new URL('callback.html', ROOT)));
      }
      if (path === '/api/broker/complete' && req.method === 'POST') {
        const input = await bodyOf(req);
        if (!brokerUrl || !pending || pending.expires < Date.now() || !validState(input.state, pending.state)) throw new Error('로그인 요청이 만료되었거나 일치하지 않습니다. 다시 로그인하세요.');
        const request = pending; pending = null;
        const result = await broker('/login/redeem', 'POST', { handoff: input.handoff, verifier: request.verifier });
        if (pending || tokens) throw new Error('다른 로그인 요청이 시작됐습니다. 다시 로그인하세요.');
        deviceToken = result.deviceToken; assignTokens(result);
        if (deviceStore) await deviceStore.save({ brokerUrl, deviceToken });
        history.length = 0; channelId = null; receivedChats = 0; lastChatAt = null;
        emit('LOGIN', true); connectFeed(); return send(200, { ok: true });
      }
      if (path === '/auth/callback' && req.method === 'GET') {
        if (brokerUrl) throw new Error('치지직 로그인 버튼으로 로그인하세요.');
        const state = url.searchParams.get('state'), code = url.searchParams.get('code');
        if (!pending || pending.expires < Date.now() || !validState(state, pending.state)) throw new Error('로그인 요청이 만료되었거나 일치하지 않습니다. 다시 로그인하세요.');
        const loginCredentials = credentials;
        pending = null;
        if (!code) throw new Error('로그인이 취소되었습니다.');
        const result = await upstream('/auth/v1/token', 'POST', { grantType: 'authorization_code', ...loginCredentials, code, state }, false);
        if (credentials !== loginCredentials) throw new Error('로그인 요청이 변경되었습니다. 다시 로그인하세요.');
        assignTokens(result);
        history.length = 0; channelId = null; receivedChats = 0; lastChatAt = null; emit('LOGIN', true); connectFeed();
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      if (path === '/api/status') return send(200, { configured: !!credentials || !!brokerUrl, brokerMode: !!brokerUrl, loggedIn: !!tokens, feedStatus, callback: CALLBACK, channelId, receivedChats, lastChatAt });
      if (path === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ type: 'HISTORY', data: history })}\n\n`); clients.add(res);
        const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(heartbeat); clients.delete(res); }); return;
      }
      if (path === '/api/login' && req.method === 'POST') {
        const input = await bodyOf(req);
        if (brokerUrl) {
          if (tokens) throw new Error('이미 로그인했습니다.');
          const verifier = randomBytes(32).toString('base64url');
          const login = { state: randomBytes(32).toString('hex'), verifier, expires: Date.now() + 600000 };
          pending = login;
          const result = await broker('/login/start', 'POST', { localState: login.state, challenge: createHash('sha256').update(verifier).digest('base64url') });
          if (pending !== login) throw new Error('로그인 요청이 변경됐습니다.');
          const target = new URL(result.url); if (target.origin !== brokerUrl) throw new Error('올바르지 않은 로그인 서버 주소입니다.');
          return send(200, result);
        }
        if (!input.clientId?.trim() || !input.clientSecret?.trim()) throw new Error('Client ID와 Client Secret을 입력하세요.');
        if (tokens) throw new Error('계정을 변경하려면 먼저 로그아웃하세요.');
        credentials = { clientId: input.clientId.trim(), clientSecret: input.clientSecret.trim() };
        pending = { state: randomBytes(32).toString('hex'), expires: Date.now() + 600000 };
        const login = new URL('https://chzzk.naver.com/account-interlock');
        login.search = new URLSearchParams({ clientId: credentials.clientId, redirectUri: CALLBACK, state: pending.state });
        return send(200, { url: login.href });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        if (tokens) {
          if (brokerUrl) await broker('/session/logout', 'POST', {});
          else await upstream('/auth/v1/token/revoke', 'POST', { ...credentials, token: tokens.accessToken, tokenTypeHint: 'access_token' }, false);
        }
        deviceToken = null;
        if (deviceStore) await deviceStore.clear();
        stopFeed(); tokens = null; credentials = null; pending = null; history.length = 0; channelId = null; receivedChats = 0; lastChatAt = null; emit('RESET', true); status('로그아웃됨'); return send(200, {});
      }
      if (path === '/api/reconnect' && req.method === 'POST') { if (!tokens) throw new Error('먼저 로그인하세요.'); connectFeed(); return send(200, {}); }
      if (path === '/api/categories' && req.method === 'GET') {
        if ((!credentials && !brokerUrl) || !tokens) throw new Error('먼저 로그인하세요.');
        const query = url.searchParams.get('query')?.trim();
        if (!query || query.length > 100) throw new Error('카테고리 이름을 1~100자로 입력하세요.');
        return send(200, brokerUrl ? await broker('/categories?query=' + encodeURIComponent(query), 'GET') : await upstream('/open/v1/categories/search?' + new URLSearchParams({ query, size: '30' }), 'GET', undefined, 'client'));
      }
      const routes = {
        '/api/live': ['GET', '/open/v1/lives/setting'],
        '/api/live/save': ['PATCH', '/open/v1/lives/setting'],
        '/api/chat/send': ['POST', '/open/v1/chats/send'],
        '/api/chat/hide': ['POST', '/open/v1/chats/blind-message'],
        '/api/chat/settings': ['GET', '/open/v1/chats/settings'],
        '/api/chat/settings/save': ['PUT', '/open/v1/chats/settings'],
        '/api/restrictions': ['GET', '/open/v1/restrict-channels'],
        '/api/restrict': ['POST', '/open/v1/restrict-channels'],
        '/api/unrestrict': ['DELETE', '/open/v1/restrict-channels']
      };
      if (routes[path]) {
        const [method, remote] = routes[path];
        if (req.method !== (method === 'GET' ? 'GET' : 'POST')) return send(405, { error: '지원하지 않는 요청입니다.' });
        let body = method === 'GET' ? undefined : await bodyOf(req);
        if (path === '/api/chat/send') body = messageBody(body);
        if (path === '/api/live/save') {
          if (!body.defaultLiveTitle?.trim()) throw new Error('방송 제목을 입력하세요.');
          if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{N}]+$/u.test(tag)))) throw new Error('태그에는 공백·특수문자를 넣을 수 없습니다. 쉼표로 태그를 구분하세요.');
          if (body.categoryType !== undefined && !['GAME', 'SPORTS', 'ETC'].includes(body.categoryType)) throw new Error('검색 결과에서 카테고리를 선택하세요.');
          if (body.categoryId !== undefined && typeof body.categoryId !== 'string') throw new Error('올바른 카테고리를 선택하세요.');
          body = Object.fromEntries(Object.entries(body).filter(([key]) => ['defaultLiveTitle', 'categoryType', 'categoryId', 'tags'].includes(key)));
        }
        if (['/api/restrict', '/api/unrestrict'].includes(path)) {
          if (!/^[a-f0-9]{32}$/i.test(body.targetChannelId || '')) throw new Error('32자리 채널 ID를 입력하세요.');
          body = { targetChannelId: body.targetChannelId };
        }
        const next = path === '/api/restrictions' ? '?size=30' + (url.searchParams.get('next') ? '&next=' + encodeURIComponent(url.searchParams.get('next')) : '') : '';
        return send(200, await call(remote + next, method, body));
      }
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/callback.js': ['callback.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && files[path]) {
        const [file, type] = files[path]; res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(await readFile(new URL(file, ROOT)));
      }
      send(404, { error: '페이지를 찾을 수 없습니다.' });
    } catch (error) { if (!res.headersSent) send(400, { error: error.message }); else res.end(); }
  });
  return { server, async restore() {
    if (!brokerUrl || !deviceStore) return;
    try {
      const saved = await deviceStore.load(); if (!saved || saved.brokerUrl !== brokerUrl) return;
      deviceToken = saved.deviceToken;
      assignTokens(await broker('/session/token', 'POST', {})); connectFeed();
    } catch { deviceToken = null; tokens = null; status('저장된 로그인을 연결할 수 없습니다. 다시 로그인하세요.'); }
  }, close: () => { stopFeed(); for (const client of clients) client.end(); server.close(); } };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let brokerUrl = process.env.STREAM_DOCK_AUTH_URL || '';
  try { brokerUrl = JSON.parse(await readFile(new URL('./auth-server.json', import.meta.url), 'utf8')).url || brokerUrl; } catch (error) { if (error.code !== 'ENOENT') throw new Error('auth-server.json 설정을 확인하세요.'); }
  const app = createApp({ brokerUrl, deviceStore: process.platform === 'win32' ? createDeviceStore(fileURLToPath(new URL('./.local/device.dat', import.meta.url))) : null });
  app.server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '이미 실행 중이거나 18765 포트가 사용 중입니다.' : error.message); process.exitCode = 1; });
  app.server.listen(18765, '127.0.0.1', () => { console.log('Stream Dock 실행됨: ' + ORIGIN); app.restore(); });
  process.on('SIGINT', () => app.close());
}
