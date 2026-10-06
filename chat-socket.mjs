import { EventEmitter } from 'node:events';

// CHZZK uses Engine.IO 3 / Socket.IO 2 text events. No binary attachments are needed.
export function connectSocket(address, { timeout = 10000, WebSocketClass = WebSocket } = {}) {
  const emitter = new EventEmitter();
  const url = new URL(address); url.protocol = 'wss:'; url.pathname = '/socket.io/';
  url.searchParams.set('EIO', '3'); url.searchParams.set('transport', 'websocket');
  const ws = new WebSocketClass(url.href);
  let heartbeat, deadline, closed = false, connected = false;
  const connectTimeout = setTimeout(() => fail('채팅 연결 시간 초과'), timeout);
  function cleanup() { clearTimeout(connectTimeout); clearTimeout(heartbeat); clearTimeout(deadline); }
  function send(packet) { if (!closed && ws.readyState === 1) ws.send(packet); }
  function fail(message) { if (closed) return; closed = true; cleanup(); ws.close(); emitter.emit('connect_error', new Error(message)); }
  function ping(interval, timeoutMs) { heartbeat = setTimeout(() => { send('2'); deadline = setTimeout(() => fail('채팅 서버 응답 시간 초과'), timeoutMs); }, interval); }
  let interval = 25000, timeoutMs = 60000;
  ws.addEventListener('message', event => {
    try {
      if (closed) return;
      if (typeof event.data !== 'string' || event.data.length > 1048576) return fail('지원하지 않는 채팅 패킷입니다.');
      const packet = event.data;
      if (packet[0] === '0') {
        const handshake = JSON.parse(packet.slice(1));
        interval = Math.min(60000, Math.max(1000, Number(handshake.pingInterval) || 25000));
        timeoutMs = Math.min(120000, Math.max(1000, Number(handshake.pingTimeout) || 60000));
        ping(interval, timeoutMs);
      } else if (packet === '3') { clearTimeout(deadline); clearTimeout(heartbeat); ping(interval, timeoutMs); }
      else if (packet === '2') send('3');
      else if (packet === '40') { if (!connected) { connected = true; clearTimeout(connectTimeout); emitter.emit('connect'); } }
      else if (packet.startsWith('42')) {
        const data = JSON.parse(packet.slice(2));
        if (Array.isArray(data) && ['SYSTEM', 'CHAT', 'DONATION', 'SUBSCRIPTION'].includes(data[0])) emitter.emit(data[0], data[1]);
      } else if (packet === '1' || packet === '41') fail('채팅 세션이 종료됐습니다.');
      else if (packet.startsWith('44')) fail('채팅 서버가 연결을 거부했습니다.');
    } catch { fail('채팅 패킷을 읽을 수 없습니다.'); }
  });
  ws.addEventListener('error', () => fail('채팅 서버 연결 오류'));
  ws.addEventListener('close', () => { if (!closed) { closed = true; cleanup(); emitter.emit('disconnect'); } });
  emitter.disconnect = () => { closed = true; cleanup(); ws.close(); };
  return emitter;
}
