'use strict';
// 入口：环境配置、HTTP 路由、静态文件、/healthz、WebSocket upgrade、信号处理。

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createStore } = require('./src/store');
const { createEngine, GameError } = require('./src/engine');
const { createWs } = require('./src/ws');

function parsePort(raw, dflt) {
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : dflt;
}

function numEnv(raw, dflt, min, max) {
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
}

const config = {
  PORT: parsePort(process.env.PORT, 8787),
  DATA_DIR: path.resolve(process.env.DATA_DIR || './data'),
  TURN_SECONDS: Math.round(numEnv(process.env.TURN_SECONDS, 40, 1, 600)),
  BOT_DELAY_MS: Math.round(numEnv(process.env.BOT_DELAY_MS, 900, 10, 60000)),
  ROOM_TTL_HOURS: numEnv(process.env.ROOM_TTL_HOURS, 24, 1, 24 * 365),
  SAVE_DEBOUNCE_MS: Math.round(numEnv(process.env.SAVE_DEBOUNCE_MS, 400, 10, 10000)),
  MAX_BODY_BYTES: Math.round(numEnv(process.env.MAX_BODY_BYTES, 32 * 1024, 1024, 1024 * 1024)),
};

const store = createStore({ dataDir: config.DATA_DIR, saveDebounceMs: config.SAVE_DEBOUNCE_MS });
const engine = createEngine({ config, store });

const STATIC = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/shared.css': { file: 'shared.css', type: 'text/css; charset=utf-8', cache: 'no-cache' },
  '/shared.js': { file: 'shared.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/50k/': { file: '50k/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/50k/index.html': { file: '50k/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/50k/app.js': { file: '50k/app.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/baohuang/': { file: 'baohuang/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/baohuang/index.html': { file: 'baohuang/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/baohuang/app.js': { file: 'baohuang/app.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/assets/joker-big.png': { file: 'assets/joker-big.png', type: 'image/png', cache: 'public, max-age=3600' },
  '/assets/joker-small.png': { file: 'assets/joker-small.png', type: 'image/png', cache: 'public, max-age=3600' },
  '/manifest.json': { file: 'manifest.json', type: 'application/manifest+json', cache: 'no-cache' },
  '/sw.js': { file: 'sw.js', type: 'text/javascript; charset=utf-8', cache: 'no-cache' },
  '/a709471779452ad70264b30b139973ed.txt': { file: 'a709471779452ad70264b30b139973ed.txt', type: 'text/plain; charset=utf-8', cache: 'no-cache' },
};

function send(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, entry) {
  const abs = path.join(__dirname, entry.file);
  const stream = fs.createReadStream(abs);
  stream.on('error', () => {
    if (!res.headersSent) send(res, 404, { error: 'not found', code: 'room-not-found' });
    else res.destroy();
  });
  stream.once('open', () => {
    res.writeHead(200, {
      'content-type': entry.type,
      'cache-control': entry.cache,
      'access-control-allow-origin': '*',
    });
    stream.pipe(res);
  });
}

function readBody(req, res, cb) {
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  req.on('data', (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > config.MAX_BODY_BYTES) {
      tooLarge = true;
      send(res, 413, { error: '请求体过大', code: 'too-large' });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return;
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
    cb(body);
  });
  req.on('error', () => {});
}

const API_ACTIONS = new Set(['create', 'join', 'state', 'start', 'play', 'pass', 'bots', 'addbot', 'removebot', 'sit', 'next', 'ready', 'leave', 'kick', 'dissolve', 'emperor', 'wind']);

function handleApi(req, res, action) {
  readBody(req, res, (b) => {
    try {
      if (action === 'create') {
        const { room, seat, token } = engine.createRoom(b.name, b.game);
        return send(res, 200, { room: room.id, seat, token, state: engine.publicState(room, seat) });
      }
      if (action === 'join') {
        const { room, seat, token } = engine.joinRoom(b.room, b.name, b.game);
        return send(res, 200, { room: room.id, seat, token, state: engine.publicState(room, seat) });
      }
      const { r, seat } = engine.authorize(b.room, b.token);
      if (action === 'state') {
        return send(res, 200, { state: engine.publicState(r, seat), serverNow: Date.now() });
      }
      engine.applyAction(r, seat, action, {
        cards: b.cards,
        seat: b.seat,
        windSeat: b.windSeat,
        yield: b.yield,
      });
      let nowSeat = seat;
      try { nowSeat = engine.requireSeat(r, b.token); } catch {}
      return send(res, 200, { seat: nowSeat, state: engine.publicState(r, nowSeat) });
    } catch (e) {
      if (e instanceof GameError) return send(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      return send(res, 500, { error: '服务器内部错误', code: 'internal' });
    }
  });
}

function handle(req, res) {
  let u;
  try {
    u = new URL(req.url, 'http://localhost');
  } catch {
    return send(res, 400, { error: 'bad request', code: 'bad-name' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  if (u.pathname === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed', code: 'bad-name' });
    return send(res, 200, {
      ok: true,
      uptime: Math.round(process.uptime()),
      rooms: engine.rooms.size,
      version: 1,
      turnSeconds: config.TURN_SECONDS,
    });
  }

  if (u.pathname === '/favicon.ico') {
    res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
    return res.end();
  }

  if (u.pathname === '/50k' || u.pathname === '/baohuang') {
    res.writeHead(301, { location: `${u.pathname}/${u.search}` });
    return res.end();
  }

  const staticEntry = STATIC[u.pathname];
  if (staticEntry) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed', code: 'bad-name' });
    return serveStatic(req, res, staticEntry);
  }

  if (req.method === 'GET' && /^\/assets\/[a-z0-9-]+\.(png|jpg)$/.test(u.pathname)) {
    const type = u.pathname.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    const entry = { file: u.pathname.slice(1), type, cache: 'public, max-age=86400' };
    return serveStatic(req, res, entry);
  }

  const m = u.pathname.match(/^\/api\/([a-z]+)\/?$/);
  if (m && API_ACTIONS.has(m[1])) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed', code: 'bad-name' });
    return handleApi(req, res, m[1]);
  }

  return send(res, 404, { error: 'not found', code: 'room-not-found' });
}

const server = http.createServer(handle);
const ws = createWs({ server, engine });
engine.setBroadcast(ws.broadcastRoom);

engine.restore(store.load());
engine.startCleanup();

server.listen(config.PORT, () => {
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : config.PORT;
  console.log(`2301桌游 listening on ${port}`);
  console.log(`DATA_DIR=${config.DATA_DIR} TURN_SECONDS=${config.TURN_SECONDS} SAVE_DEBOUNCE_MS=${config.SAVE_DEBOUNCE_MS}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, saving rooms...`);
  store.flushSync(engine.rooms);
  for (const r of engine.rooms.values()) engine.clearTimers(r);
  ws.closeAll();
  const watchdog = setTimeout(() => process.exit(0), 2000);
  if (watchdog.unref) watchdog.unref();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
