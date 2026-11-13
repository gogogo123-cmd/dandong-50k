'use strict';
// WebSocket 实时通道：hello 鉴权、座位个性化广播、心跳、在线状态。

const { WebSocketServer } = require('ws');

const HELLO_TIMEOUT_MS = 5000;
const MAX_BUFFERED = 256 * 1024;

function createWs({ server, engine, heartbeatMs = 30000 }) {
  const wss = new WebSocketServer({ noServer: true });

  function send(ws, obj) {
    if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  function broadcastRoom(r) {
    for (const [seat, set] of r.sockets) {
      for (const ws of set) {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED) continue;
        try {
          ws.send(JSON.stringify({
            type: 'state',
            state: engine.publicState(r, seat),
            serverNow: Date.now(),
          }));
        } catch {}
      }
    }
  }

  function cleanup(ws) {
    if (ws._cleaned) return;
    ws._cleaned = true;
    clearTimeout(ws._helloTimer);
    if (ws.authed) {
      const r = engine.rooms.get(ws.roomId);
      if (r) engine.detachSocket(r, ws.seat, ws);
    }
    ws.authed = false;
  }

  function handleHello(ws, msg) {
    try {
      if (ws.authed) {
        const oldRoom = engine.rooms.get(ws.roomId);
        if (oldRoom) engine.detachSocket(oldRoom, ws.seat, ws);
        ws.authed = false;
      }
      const { r, seat } = engine.authorize(msg.room, msg.token);
      ws.authed = true;
      ws.roomId = r.id;
      ws.seat = seat;
      clearTimeout(ws._helloTimer);
      send(ws, {
        type: 'hello',
        ok: true,
        seat,
        room: r.id,
        state: engine.publicState(r, seat),
        serverNow: Date.now(),
      });
      engine.attachSocket(r, seat, ws);
    } catch (e) {
      send(ws, {
        type: 'hello',
        ok: false,
        code: e.code || 'auth',
        message: e.message || '身份验证失败，请重新加入',
      });
      setTimeout(() => {
        try { ws.close(4001, 'auth'); } catch {}
      }, 10);
    }
  }

  function handleAction(ws, msg) {
    const requestId = msg.requestId;
    const r = engine.rooms.get(ws.roomId);
    if (!r) {
      send(ws, { type: 'error', requestId, code: 'room-not-found', message: '牌桌不存在或服务已重启' });
      return;
    }
    try {
      engine.applyAction(r, ws.seat, msg.action, { cards: msg.cards, seat: msg.seat });
      send(ws, { type: 'ack', requestId, ok: true });
    } catch (e) {
      send(ws, {
        type: 'error',
        requestId,
        code: e.code || 'error',
        message: e.message || '操作失败',
      });
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.authed = false;
    ws._cleaned = false;
    ws._helloTimer = setTimeout(() => {
      if (!ws.authed) {
        try { ws.close(4001, 'hello timeout'); } catch {}
      }
    }, HELLO_TIMEOUT_MS);
    if (ws._helloTimer.unref) ws._helloTimer.unref();

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => cleanup(ws));
    ws.on('error', () => cleanup(ws));

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        send(ws, { type: 'error', code: 'bad-json', message: '消息格式错误' });
        return;
      }
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
        return;
      }
      if (!ws.authed) {
        if (msg.type === 'hello') {
          handleHello(ws, msg);
        } else {
          send(ws, { type: 'error', code: 'auth', message: '请先完成 hello 鉴权' });
        }
        return;
      }
      if (msg.type === 'hello') {
        handleHello(ws, msg);
        return;
      }
      if (msg.type === 'action') {
        handleAction(ws, msg);
      }
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, heartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  function closeAll() {
    clearInterval(heartbeat);
    for (const ws of wss.clients) {
      try { ws.close(1001, 'server shutdown'); } catch {}
    }
    try { wss.close(); } catch {}
  }

  return { wss, broadcastRoom, closeAll };
}

module.exports = { createWs };
