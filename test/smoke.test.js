'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dd50k-'));
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
        TURN_SECONDS: '2',
        BOT_DELAY_MS: '50',
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
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
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

async function createSix(server) {
  const created = await api(server, 'create', { name: 'P0' });
  assert.equal(created.status, 200);
  const room = created.body.room;
  const players = [{ seat: created.body.seat, token: created.body.token }];
  for (let i = 1; i < 6; i++) {
    const j = await api(server, 'join', { room, name: `P${i}` });
    assert.equal(j.status, 200, JSON.stringify(j.body));
    players.push({ seat: j.body.seat, token: j.body.token });
  }
  return { room, players };
}

async function waitForState(server, room, token, pred, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await getState(server, room, token);
    if (pred(last)) return last;
    await sleep(120);
  }
  throw new Error(`condition not met before timeout. last state log: ${JSON.stringify(last && last.log)}`);
}

function smallest(hand) {
  return [...hand].sort((a, b) => a.rank - b.rank || a.suit - b.suit)[0];
}

test('timeout while leading auto-plays the smallest single card', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const { room, players } = await createSix(server);
    const started = await api(server, 'start', { room, token: players[0].token });
    assert.equal(started.status, 200, JSON.stringify(started.body));

    let turnSeat = -1;
    let turnToken = '';
    let initial = null;
    for (const p of players) {
      const s = await getState(server, room, p.token);
      if (s.started && s.turn === p.seat) {
        turnSeat = p.seat;
        turnToken = p.token;
        initial = s;
        break;
      }
    }
    assert.ok(initial, 'found the leading player');
    assert.equal(initial.lead, null);
    const min = smallest(initial.hand);
    const oldDeadline = initial.turnDeadline;
    assert.equal(initial.hand.length, 23);

    const s = await waitForState(server, room, turnToken, (st) => (st.log || []).some((x) => x.includes('超时，自动出最小单张')));
    assert.equal(s.hand.length, 22);
    assert.ok(s.lead, 'a lead exists after automatic play');
    assert.equal(s.lead.seat, turnSeat);
    assert.equal(s.lead.cards.length, 1);
    assert.equal(s.lead.cards[0].id, min.id);
    assert.ok(s.turnDeadline > oldDeadline, 'deadline renewed for next player');
    assert.ok(s.log.some((x) => x.includes('超时，自动出最小单张')));
  } finally {
    await stopServer(server);
  }
});

test('timeout while following auto-passes', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const { room, players } = await createSix(server);
    await api(server, 'start', { room, token: players[0].token });

    let leader = null;
    let initial = null;
    for (const p of players) {
      const s = await getState(server, room, p.token);
      if (s.started && s.turn === p.seat) {
        leader = p;
        initial = s;
        break;
      }
    }
    assert.ok(leader);
    const card = smallest(initial.hand);
    const played = await api(server, 'play', { room, token: leader.token, cards: [card.id] });
    assert.equal(played.status, 200, JSON.stringify(played.body));
    assert.equal(played.body.state.lead.cards[0].id, card.id);

    const s = await waitForState(server, room, leader.token, (st) => (st.log || []).some((x) => x.includes('超时，自动不要')), 6000);
    assert.ok(s.passes >= 1);
    assert.notEqual(s.turn, leader.seat, 'turn rotated after automatic pass');
    assert.ok(s.log.some((x) => x.includes('超时，自动不要')));
  } finally {
    await stopServer(server);
  }
});

test('a full three-round match with bots completes and starts a new big set', { timeout: 180000 }, async () => {
  const server = await startServer({ env: { TURN_SECONDS: '2', BOT_DELAY_MS: '20' } });
  try {
    const created = await api(server, 'create', { name: '真人' });
    assert.equal(created.status, 200);
    const room = created.body.room;
    const token = created.body.token;
    const bots = await api(server, 'bots', { room, token });
    assert.equal(bots.status, 200, JSON.stringify(bots.body));

    const seat = created.body.seat;
    const end = Date.now() + 150000;
    let s = bots.body.state;
    while (Date.now() < end) {
      s = await getState(server, room, token);
      if (s.finished) {
        if (s.gamesPlayed >= 3) break;
        const n = await api(server, 'next', { room, token });
        assert.equal(n.status, 200, JSON.stringify(n.body));
      } else if (s.started && s.turn === seat) {
        let r;
        if (s.lead) {
          r = await api(server, 'pass', { room, token });
          if (r.status !== 200 && r.body.code === 'no-lead') {
            r = await api(server, 'play', { room, token, cards: [smallest(s.hand).id] });
          }
        } else {
          r = await api(server, 'play', { room, token, cards: [smallest(s.hand).id] });
        }
        assert.equal(r.status, 200, JSON.stringify(r.body));
      }
      await sleep(40);
    }
    assert.ok(s.finished, 'round three finished');
    assert.equal(s.gamesPlayed, 3);
    assert.equal(s.matchResults.length, 3);
    assert.equal(s.bigSet, 1);

    const next = await api(server, 'next', { room, token });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    assert.equal(next.body.state.bigSet, 2);
    assert.equal(next.body.state.gamesPlayed, 0);
    assert.equal(next.body.state.matchResults.length, 0);
    assert.equal(next.body.state.started, true);
  } finally {
    await stopServer(server);
  }
});

test('rooms persist across SIGTERM and restore with the same token', { timeout: 60000 }, async () => {
  const dir = tempDir();
  let server = await startServer({ dir, env: { TURN_SECONDS: '5' } });
  let room, token, seat, recorded;
  try {
    const six = await createSix(server);
    room = six.room;
    token = six.players[0].token;
    seat = six.players[0].seat;
    await api(server, 'start', { room, token });

    let leadToken = token;
    for (const p of six.players) {
      const s = await getState(server, room, p.token);
      if (s.turn === p.seat) {
        leadToken = p.token;
        break;
      }
    }
    await waitForState(server, room, leadToken, (st) => (st.log || []).some((x) => x.includes('超时，自动')), 8000);
    recorded = await getState(server, room, token);
    assert.ok(recorded.hand.length === 23 || recorded.hand.length === 22);

    await sleep(300);
    await stopServer(server);
    server = null;

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'));
    assert.equal(saved.schema, 1);
    assert.equal(saved.rooms.length, 1);
    assert.equal(saved.rooms[0].id, room);

    server = await startServer({ dir, env: { TURN_SECONDS: '5' } });
    const restored = await getState(server, room, token);
    assert.equal(restored.id, room);
    assert.equal(restored.turn, recorded.turn);
    assert.equal(restored.version, recorded.version);
    assert.equal(restored.turnDeadline, recorded.turnDeadline);
    assert.deepEqual(restored.scores, recorded.scores);
    assert.deepEqual(restored.hand.map((c) => c.id), recorded.hand.map((c) => c.id));

    const bad = await api(server, 'state', { room, token: 'not-a-token' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'auth');

    const hello = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error('ws hello timeout')); }, 5000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', room, token: 'not-a-token' })));
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'hello') {
          clearTimeout(timer);
          const result = { ok: msg.ok, code: msg.code };
          ws.on('close', (code) => resolve({ ...result, closeCode: code }));
        }
      });
      ws.on('error', reject);
    });
    assert.equal(hello.ok, false);
    assert.equal(hello.code, 'auth');
    assert.equal(hello.closeCode, 4001);
  } finally {
    if (server) await stopServer(server);
  }
});

test('WebSocket pushes state to other seats after a REST play', { timeout: 30000 }, async () => {
  const server = await startServer();
  try {
    const { room, players } = await createSix(server);
    await api(server, 'start', { room, token: players[0].token });

    let turnPlayer = players[0];
    let initial = null;
    for (const p of players) {
      const s = await getState(server, room, p.token);
      if (s.turn === p.seat) {
        turnPlayer = p;
        initial = s;
        break;
      }
    }
    assert.ok(initial);
    const min = smallest(initial.hand);
    const version = initial.version;

    const connect = (p) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      const timer = setTimeout(() => { try { ws.close(); } catch {}; reject(new Error('hello timeout')); }, 5000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', room, token: p.token })));
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === 'hello') {
          clearTimeout(timer);
          assert.equal(msg.ok, true);
          resolve(ws);
        }
      });
      ws.on('error', reject);
    });

    const wsA = await connect(players[0]);
    const wsB = await connect(players[1]);
    try {
      const pushed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no ws state push within 500ms')), 500);
        wsB.on('message', (data) => {
          const msg = JSON.parse(String(data));
          if (msg.type === 'state' && msg.state.version > version) {
            clearTimeout(timer);
            resolve(msg);
          }
        });
      });

      const played = await api(server, 'play', { room, token: turnPlayer.token, cards: [min.id] });
      assert.equal(played.status, 200, JSON.stringify(played.body));

      const msg = await pushed;
      assert.ok(msg.state.version > version);
      assert.equal(msg.state.players[turnPlayer.seat].lastPlay[0].id, min.id);
      const bHand = await getState(server, room, players[1].token);
      assert.deepEqual(msg.state.hand.map((c) => c.id), bHand.hand.map((c) => c.id));
    } finally {
      wsA.close();
      wsB.close();
    }
  } finally {
    await stopServer(server);
  }
});
