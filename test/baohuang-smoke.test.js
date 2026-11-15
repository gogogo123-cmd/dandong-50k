'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bh-'));
}

function startServer({ dir, env = {} } = {}) {
  const dataDir = dir || tempDir();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: '0',
        DATA_DIR: dataDir,
        TURN_SECONDS: '1',
        BOT_DELAY_MS: '10',
        SAVE_DEBOUNCE_MS: '50',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`server start timeout\n${out}`));
    }, 8000);
    const onData = (chunk) => {
      out += chunk.toString();
      const m = out.match(/listening on (\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), dir: dataDir, output: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`server exited early (${code})\n${out}`));
      }
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || server.child.exitCode !== null) return resolve();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    server.child.once('exit', finish);
    server.child.kill('SIGTERM');
    setTimeout(() => {
      if (done) return;
      try { server.child.kill('SIGKILL'); } catch {}
      finish();
    }, 4000);
  });
}

async function api(server, action, body = {}) {
  const r = await fetch(`http://127.0.0.1:${server.port}/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return { status: r.status, body: j };
}

async function getState(server, room, token) {
  const r = await api(server, 'state', { room, token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.state;
}

async function createBaohuang(server, bots = false) {
  const created = await api(server, 'create', { name: 'Host', game: 'baohuang' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const room = created.body.room;
  const token = created.body.token;
  if (bots) {
    for (let i = 1; i < 5; i++) {
      const b = await api(server, 'addbot', { room, token, seat: i });
      assert.equal(b.status, 200, JSON.stringify(b.body));
    }
  }
  return { room, token, seat: created.body.seat, state: created.body.state };
}

function findTriple(hand) {
  const groups = new Map();
  for (const c of hand) {
    if (c.rank < 7 || c.rank > 15) continue;
    const key = `${c.suit}-${c.rank}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const cards of groups.values()) if (cards.length === 3) return cards;
  return null;
}

test('保皇房间：5 座、157 张、每人一张 6；机器人整局可结算并可再来一局', { timeout: 150000 }, async () => {
  const server = await startServer();
  try {
    const { room, token, seat } = await createBaohuang(server, true);
    const started = await api(server, 'start', { room, token });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    let s = started.body.state;
    assert.equal(s.game, 'baohuang');
    assert.equal(s.numSeats, 5);
    assert.equal(s.phase, 'emperor');
    assert.equal(s.started, true);
    assert.equal(s.players.length, 5);
    assert.equal(s.players.reduce((n, p) => n + p.count, 0), 157);
    const sizes = s.players.map((p) => p.count).sort();
    assert.deepEqual(sizes, [31, 31, 31, 32, 32]);
    assert.equal(s.hand.filter((c) => c.rank === 6).length, 1);
    assert.ok(s.players.every((p) => p.remaining === null), '未结算不泄露他人手牌');
    assert.equal(s.guardSeat, null, '登基前没有侍卫信息');

    const end = Date.now() + 120000;
    while (Date.now() < end) {
      s = await getState(server, room, token);
      if (s.finished) break;
      if (s.actorSeat === seat) {
        let r;
        if (s.phase === 'emperor') {
          const triple = findTriple(s.hand);
          r = triple
            ? await api(server, 'emperor', { room, token, cards: triple.map((c) => c.id) })
            : await api(server, 'emperor', { room, token, yield: true });
        } else if (s.phase === 'wind') {
          r = await api(server, 'wind', { room, token, seat: s.windOptions[0] });
        } else if (s.lead) {
          r = await api(server, 'pass', { room, token });
        } else {
          const pick = s.hand.find((c) => c.rank !== 6) || s.hand[0];
          r = await api(server, 'play', { room, token, cards: [pick.id] });
        }
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      await sleep(60);
    }
    assert.ok(s.finished, '游戏应完成');
    assert.equal(s.phase, 'settlement');
    assert.ok(s.winnerCamp === 'emperor' || s.winnerCamp === 'revolution');
    assert.ok(Array.isArray(s.rankings) && s.rankings.length >= 2);
    assert.equal(s.guardPublic, true);
    assert.ok(Number.isInteger(s.guardSeat));
    assert.equal(s.players[s.guardSeat].role, 'guard');
    assert.equal(s.players[s.emperorSeat].role, 'emperor');
    assert.ok(s.players.every((p) => Array.isArray(p.remaining)));
    assert.equal(s.players.reduce((n, p) => n + p.remaining.length, 0) + (157 - s.players.reduce((n, p) => n + p.remaining.length, 0)), 157);

    const denied = await api(server, 'next', { room, token: 'not-a-token' });
    assert.equal(denied.status, 401);

    const next = await api(server, 'next', { room, token });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    const ns = next.body.state;
    assert.equal(ns.phase, 'emperor');
    assert.equal(ns.finished, false);
    assert.deepEqual(ns.rankings, []);
    assert.equal(ns.guardPublic, false);
    assert.equal(ns.players.reduce((n, p) => n + p.count, 0), 157);
    assert.equal(ns.hand.filter((c) => c.rank === 6).length, 1);
  } finally {
    await stopServer(server);
  }
});

test('房间码共享但校验游戏类型', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const { room } = await createBaohuang(server, false);
    const wrong = await api(server, 'join', { room, name: 'X', game: '50k' });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'wrong-game');
    const ok = await api(server, 'join', { room, name: 'X', game: 'baohuang' });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.state.numSeats, 5);

    const fifty = await api(server, 'create', { name: 'F', game: '50k' });
    const wrong2 = await api(server, 'join', { room: fifty.body.room, name: 'Y', game: 'baohuang' });
    assert.equal(wrong2.status, 409);
    assert.equal(wrong2.body.code, 'wrong-game');
  } finally {
    await stopServer(server);
  }
});

test('保皇房间持久化：重启后恢复手牌与阶段', { timeout: 60000 }, async () => {
  const dir = tempDir();
  let server = await startServer({ dir, env: { TURN_SECONDS: '30' } });
  try {
    const created = await api(server, 'create', { name: 'Host', game: 'baohuang' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const room = created.body.room;
    const token = created.body.token;
    const players = [{ seat: created.body.seat, token }];
    for (let i = 1; i < 5; i++) {
      const j = await api(server, 'join', { room, name: `P${i}`, game: 'baohuang' });
      assert.equal(j.status, 200, JSON.stringify(j.body));
      players.push({ seat: j.body.seat, token: j.body.token });
      const r = await api(server, 'ready', { room, token: j.body.token });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const started = await api(server, 'start', { room, token });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const recorded = await getState(server, room, token);
    await sleep(300);
    await stopServer(server);
    server = null;

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'));
    assert.equal(saved.rooms.length, 1);
    assert.equal(saved.rooms[0].game, 'baohuang');
    assert.equal(saved.rooms[0].numSeats, 5);

    server = await startServer({ dir, env: { TURN_SECONDS: '30' } });
    const restored = await getState(server, room, token);
    assert.equal(restored.game, 'baohuang');
    assert.equal(restored.phase, recorded.phase);
    assert.equal(restored.candidateSeat, recorded.candidateSeat);
    assert.deepEqual(restored.hand.map((c) => c.id), recorded.hand.map((c) => c.id));
    assert.equal(restored.version, recorded.version);
    assert.equal(restored.turnDeadline, recorded.turnDeadline);
  } finally {
    if (server) await stopServer(server);
  }
});
