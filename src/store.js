'use strict';
// 房间持久化：防抖原子写（tmp + rename）、启动加载、SIGTERM 同步落盘。

const fs = require('fs');
const path = require('path');

const SCHEMA = 1;

function serializeRoom(r) {
  return {
    id: r.id,
    players: r.players.map((p) => (p ? {
      name: p.name,
      hand: p.hand,
      bot: !!p.bot,
      done: !!p.done,
      ready: !!p.ready,
      tokenHash: p.tokenHash || null,
    } : null)),
    teams: r.teams,
    positions: r.positions,
    playedBy: r.playedBy,
    passed: r.passed,
    started: r.started,
    turn: r.turn,
    lead: r.lead,
    passes: r.passes,
    finished: r.finished,
    bigEmperor: r.bigEmperor,
    scores: r.scores,
    trickPoints: r.trickPoints,
    gamesPlayed: r.gamesPlayed,
    bigSet: r.bigSet,
    matchResults: r.matchResults,
    log: (r.log || []).slice(-200),
    windSeq: r.windSeq || 0,
    lastWind: r.lastWind || null,
    roundWinner: r.roundWinner,
    leftoverPoints: r.leftoverPoints,
    penalty: r.penalty,
    version: r.version,
    turnDeadline: r.turnDeadline ?? null,
    hostSeat: r.hostSeat,
    lastActivityAt: r.lastActivityAt,
  };
}

function createStore({ dataDir, saveDebounceMs }) {
  const file = path.join(dataDir, 'rooms.json');
  let dirty = false;
  let timer = null;
  let gen = 0;
  let writeChain = Promise.resolve();

  function load() {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || data.schema !== SCHEMA || !Array.isArray(data.rooms)) return [];
      return data.rooms;
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('加载 rooms.json 失败：', e.message);
      return [];
    }
  }

  function serialize(rooms) {
    return JSON.stringify({
      schema: SCHEMA,
      savedAt: Date.now(),
      rooms: [...rooms.values()].filter((r) => !r.closed).map(serializeRoom),
    });
  }

  async function writeAtomic(text, myGen) {
    const tmp = `${file}.${process.pid}.${myGen}.tmp`;
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(tmp, text);
    if (myGen !== gen) {
      try { await fs.promises.unlink(tmp); } catch {}
      return;
    }
    await fs.promises.rename(tmp, file);
  }

  function flushNow(rooms) {
    if (!dirty) return writeChain;
    dirty = false;
    const text = serialize(rooms);
    const myGen = ++gen;
    writeChain = writeChain
      .then(() => writeAtomic(text, myGen))
      .catch((e) => console.error('保存 rooms.json 失败：', e.message));
    return writeChain;
  }

  function scheduleSave(rooms) {
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flushNow(rooms);
    }, saveDebounceMs);
    if (timer.unref) timer.unref();
  }

  function flushSync(rooms) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    dirty = false;
    const text = serialize(rooms);
    const myGen = ++gen;
    const tmp = `${file}.${process.pid}.${myGen}.sync.tmp`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('同步保存 rooms.json 失败：', e.message);
    }
  }

  return { file, load, serialize, scheduleSave, flushNow, flushSync };
}

module.exports = { createStore, SCHEMA };
