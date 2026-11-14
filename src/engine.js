'use strict';
// 房间与操作管线：身份 token、公开状态、统一变更管线（afterMutation）、倒计时与机器人调度。

const crypto = require('crypto');
const rules = require('./rules');
const { classify, beats, teamName, startGame, nextGame, finishCard, passTurn, botAct } = rules;

const MAX_ROOMS = 500;
const PRESENCE_MS = 15000;

class GameError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status || 400;
  }
}

function cleanName(raw) {
  if (typeof raw !== 'string') throw new GameError('bad-name', '请输入昵称', 400);
  const name = raw.normalize('NFKC').replace(/\p{Cc}/gu, '').replace(/\s+/g, ' ').trim();
  if (!name) throw new GameError('bad-name', '昵称不能为空', 400);
  if ([...name].length > 12) throw new GameError('bad-name', '昵称最多12个字符', 400);
  return name;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function emptyRoom(id) {
  return {
    id,
    players: Array(6).fill(null),
    teams: [0, 1, 0, 1, 0, 1],
    positions: [0, 1, 2, 3, 4, 5],
    playedBy: Array(6).fill(null),
    passed: Array(6).fill(false),
    closed: false,
    started: false,
    turn: 0,
    lead: null,
    passes: 0,
    finished: false,
    bigEmperor: null,
    scores: [0, 0],
    trickPoints: 0,
    gamesPlayed: 0,
    bigSet: 1,
    matchResults: [],
    log: [],
    windSeq: 0,
    lastWind: null,
    roundWinner: null,
    leftoverPoints: 0,
    penalty: 0,
    version: 0,
    turnDeadline: null,
    lastActivityAt: Date.now(),
    lastSeen: {},
    hostSeat: 0,
    sockets: new Map(),
    _turnTimer: null,
    _botTimer: null,
  };
}

function isCard(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && Number.isInteger(c.rank) && Number.isInteger(c.suit);
}

function createEngine({ config, store }) {
  const rooms = new Map();
  let broadcast = () => {};

  function setBroadcast(fn) {
    broadcast = typeof fn === 'function' ? fn : () => {};
  }

  function newPlayer(name, bot = false) {
    const token = bot ? null : crypto.randomBytes(24).toString('base64url');
    return {
      player: { name, hand: [], bot, done: false, ready: bot, tokenHash: token ? hashToken(token) : null },
      token,
    };
  }

  function getRoom(id) {
    const r = rooms.get(String(id || '').toUpperCase());
    if (!r) throw new GameError('room-not-found', '牌桌不存在或服务已重启', 404);
    return r;
  }

  function findSeatByToken(r, token) {
    if (typeof token !== 'string' || !token) return -1;
    const wanted = Buffer.from(hashToken(token), 'hex');
    for (let i = 0; i < 6; i++) {
      const p = r.players[i];
      if (!p || !p.tokenHash) continue;
      const stored = Buffer.from(p.tokenHash, 'hex');
      if (stored.length === wanted.length && crypto.timingSafeEqual(stored, wanted)) return i;
    }
    return -1;
  }

  function requireSeat(r, token) {
    const seat = findSeatByToken(r, token);
    if (seat < 0) throw new GameError('auth', '身份验证失败，请重新加入', 401);
    return seat;
  }

  function touch(r, seat) {
    r.lastSeen[seat] = Date.now();
  }

  function isOnline(r, seat) {
    const p = r.players[seat];
    if (!p) return false;
    if (p.bot) return true;
    const set = r.sockets.get(seat);
    if (set && set.size) return true;
    return Date.now() - (r.lastSeen[seat] || 0) < PRESENCE_MS;
  }

  function canStart(r) {
    return !r.started && r.players.every(Boolean)
      && r.players.every((p, i) => p.bot || i === r.hostSeat || p.ready);
  }

  function publicState(r, seat) {
    return {
      id: r.id,
      players: r.players.map((p, i) => p && ({
        seat: i,
        name: p.name,
        team: teamName(r, r.teams[i]),
        done: p.done,
        bot: !!p.bot,
        ready: !!p.ready,
        count: p.hand.length,
        remaining: r.finished ? p.hand.map((c) => ({ ...c })) : null,
        online: isOnline(r, i),
        lastPlay: r.playedBy?.[i] || null,
      })),
      positions: r.positions,
      yourSeat: seat,
      hand: r.players[seat]?.hand || [],
      turn: r.turn,
      lead: r.lead,
      passes: r.passes,
      passed: (r.passed || []).slice(),
      closed: !!r.closed,
      canStart: canStart(r),
      scores: r.scores,
      trickPoints: r.trickPoints,
      finished: r.finished,
      lastWind: r.lastWind || null,
      bigEmperor: r.bigEmperor,
      matchResults: r.matchResults,
      gamesPlayed: r.gamesPlayed,
      bigSet: r.bigSet,
      roundWinner: r.roundWinner,
      leftoverPoints: r.leftoverPoints,
      penalty: r.penalty,
      log: r.log.slice(-12),
      started: r.started,
      version: r.version,
      turnDeadline: r.turnDeadline ?? null,
      serverNow: Date.now(),
      turnSeconds: config.TURN_SECONDS,
      hostSeat: r.hostSeat,
    };
  }

  function ensureCapacity() {
    if (rooms.size < MAX_ROOMS) return;
    let oldest = null;
    for (const r of rooms.values()) {
      const busy = [...r.sockets.values()].some((s) => s.size);
      if (busy) continue;
      if (!oldest || (r.lastActivityAt || 0) < (oldest.lastActivityAt || 0)) oldest = r;
    }
    if (!oldest) return;
    clearTimers(oldest);
    rooms.delete(oldest.id);
    if (store) store.scheduleSave(rooms);
  }

  function createRoom(rawName) {
    const name = cleanName(rawName);
    ensureCapacity();
    let id;
    do {
      id = crypto.randomBytes(3).toString('hex').toUpperCase();
    } while (rooms.has(id));
    const r = emptyRoom(id);
    const { player, token } = newPlayer(name);
    r.players[0] = player;
    r.hostSeat = 0;
    touch(r, 0);
    rooms.set(id, r);
    afterMutation(r);
    return { room: r, seat: 0, token };
  }

  function joinRoom(roomId, rawName) {
    const r = getRoom(roomId);
    if (r.started) throw new GameError('started', '牌局已开始，无法加入', 409);
    const name = cleanName(rawName);
    const seat = r.players.findIndex((p) => !p);
    if (seat < 0) throw new GameError('full', '牌桌已坐满', 409);
    const { player, token } = newPlayer(name);
    r.players[seat] = player;
    touch(r, seat);
    afterMutation(r);
    return { room: r, seat, token };
  }

  function authorize(roomId, token) {
    const r = getRoom(roomId);
    const seat = requireSeat(r, token);
    const wasOnline = isOnline(r, seat);
    touch(r, seat);
    if (!wasOnline) {
      try {
        broadcast(r);
      } catch (e) {
        console.error('presence broadcast failed', e);
      }
    }
    return { r, seat };
  }

  function clearSeat(r, seat) {
    r.players[seat] = null;
    delete r.lastSeen[seat];
    if (r.passed) r.passed[seat] = false;
  }

  function transferHost(r, from) {
    const fromPos = r.positions?.[from] ?? from;
    for (let step = 1; step <= 6; step++) {
      const pos = (fromPos + step) % 6;
      const i = r.positions?.indexOf(pos) ?? pos;
      if (i >= 0 && i < 6 && r.players[i] && !r.players[i].bot) {
        r.hostSeat = i;
        return true;
      }
    }
    return false;
  }

  function closeSeatSockets(r, seat, msg, code) {
    const set = r.sockets.get(seat);
    if (!set) return;
    for (const ws of set) {
      try { ws.send(JSON.stringify(msg)); } catch {}
      try { ws.close(code); } catch {}
    }
    r.sockets.delete(seat);
  }

  function hasHuman(r) {
    return r.players.some((p) => p && !p.bot);
  }

  function dissolveRoom(r) {
    r.closed = true;
    clearTimers(r);
    r.turnDeadline = null;
    for (const set of r.sockets.values()) {
      for (const ws of set) {
        try { ws.send(JSON.stringify({ type: 'closed' })); } catch {}
      }
    }
    afterMutation(r);
    const t = setTimeout(() => {
      rooms.delete(r.id);
      if (store) store.scheduleSave(rooms);
    }, 800);
    if (t.unref) t.unref();
  }

  function removePlayer(r, seat, reason) {
    if (!r.players[seat]) return;
    const wasHost = seat === r.hostSeat;
    clearSeat(r, seat);
    if (wasHost) transferHost(r, seat);
    const gone = !hasHuman(r);
    closeSeatSockets(r, seat, { type: 'removed', reason }, 4003);
    if (gone) dissolveRoom(r);
    else afterMutation(r);
  }

  // 已开局的机器人房允许真人随时退出：有其他人则转托管给机器人，没有则解散。
  function leaveStartedRoom(r, seat) {
    const p = r.players[seat];
    if (!p) return;
    const othersHuman = r.players.some((x, i) => x && i !== seat && !x.bot);
    closeSeatSockets(r, seat, { type: 'removed', reason: 'left' }, 4003);
    if (!othersHuman) {
      dissolveRoom(r);
      return;
    }
    p.bot = true;
    p.tokenHash = null;
    p.ready = true;
    delete r.lastSeen[seat];
    if (seat === r.hostSeat) transferHost(r, seat);
    r.log.push(`${p.name} 退出，由机器人托管`);
    afterMutation(r);
  }

  function applyAction(r, seat, action, payload = {}) {
    const p = r.players[seat];
    if (!p) throw new GameError('auth', '身份验证失败，请重新加入', 401);
    if (p.bot) throw new GameError('auth', '机器人座位由系统操作', 403);
    touch(r, seat);

    if (action === 'start') {
      if (r.started) throw new GameError('started', '牌局已经开始', 409);
      if (seat !== r.hostSeat) throw new GameError('host-only', '只有房主可以开始游戏', 403);
      if (r.players.some((x) => !x)) throw new GameError('full', '需要六位玩家全部入座', 409);
      if (!canStart(r)) throw new GameError('not-ready', '还有玩家未准备', 409);
      startGame(r);
      return afterMutation(r);
    }

    if (action === 'next') {
      if (!r.finished) throw new GameError('finished', '本小局尚未结束', 409);
      if (r.gamesPlayed >= 3 && seat !== r.hostSeat) {
        throw new GameError('host-only', '三小局已结束，等待房主重新分组', 403);
      }
      nextGame(r);
      return afterMutation(r);
    }

    if (action === 'ready') {
      if (r.started) throw new GameError('started', '牌局已经开始', 409);
      p.ready = !p.ready;
      return afterMutation(r);
    }

    if (action === 'leave') {
      if (r.started) {
        leaveStartedRoom(r, seat);
        return r;
      }
      removePlayer(r, seat, 'left');
      return r;
    }

    if (action === 'kick') {
      if (seat !== r.hostSeat) throw new GameError('host-only', '只有房主可以踢人', 403);
      if (r.started) throw new GameError('started', '牌局已经开始了', 409);
      const target = Number(payload.seat);
      if (!Number.isInteger(target) || target < 0 || target > 5 || target === seat) {
        throw new GameError('bad-target', '无效的目标座位', 400);
      }
      const tp = r.players[target];
      if (!tp || tp.bot) throw new GameError('bad-target', '该座位没有可踢出的玩家', 400);
      if (tp.ready) throw new GameError('bad-target', '已准备的玩家不能踢出', 403);
      removePlayer(r, target, 'kicked');
      return r;
    }

    if (action === 'dissolve') {
      if (seat !== r.hostSeat) throw new GameError('host-only', '只有房主可以解散房间', 403);
      dissolveRoom(r);
      return r;
    }

    if (action === 'addbot') {
      if (seat !== r.hostSeat) throw new GameError('host-only', '只有房主可以加入机器人', 403);
      if (r.started) throw new GameError('started', '牌局已经开始', 409);
      const target = Number(payload.seat);
      if (!Number.isInteger(target) || target < 0 || target > 5) {
        throw new GameError('bad-target', '无效的目标座位', 400);
      }
      if (r.players[target]) throw new GameError('bad-target', '该座位已有玩家', 409);
      r.players[target] = newPlayer(`机器人${target}`, true).player;
      return afterMutation(r);
    }

    if (action === 'removebot') {
      if (seat !== r.hostSeat) throw new GameError('host-only', '只有房主可以移除机器人', 403);
      if (r.started) throw new GameError('started', '牌局已经开始', 409);
      const target = Number(payload.seat);
      if (!Number.isInteger(target) || target < 0 || target > 5) {
        throw new GameError('bad-target', '无效的目标座位', 400);
      }
      const tp = r.players[target];
      if (!tp || !tp.bot) throw new GameError('bad-target', '该座位没有机器人', 400);
      clearSeat(r, target);
      return afterMutation(r);
    }

    if (action === 'sit') {
      if (r.started) throw new GameError('started', '牌局已经开始', 409);
      const target = Number(payload.seat);
      if (!Number.isInteger(target) || target < 0 || target > 5 || target === seat) {
        throw new GameError('bad-target', '无效的目标座位', 400);
      }
      if (r.players[target]) throw new GameError('bad-target', '该座位已有玩家', 409);
      const set = r.sockets.get(seat);
      if (set) {
        r.sockets.delete(seat);
        r.sockets.set(target, set);
        for (const ws of set) ws.seat = target;
      }
      r.players[target] = p;
      r.players[seat] = null;
      delete r.lastSeen[seat];
      touch(r, target);
      if (r.hostSeat === seat) r.hostSeat = target;
      return afterMutation(r);
    }

    if (action === 'bots') {
      if (seat !== r.hostSeat) throw new GameError('host-only', '只有房主可以加入机器人', 403);
      if (r.started) throw new GameError('started', '牌局已经开始', 409);
      const target = Number(payload.seat);
      if (Number.isInteger(target) && target >= 0 && target <= 5) {
        if (r.players[target]) throw new GameError('bad-target', '该座位已有玩家', 409);
        r.players[target] = newPlayer(`机器人${target}`, true).player;
        return afterMutation(r);
      }
      for (let i = 0; i < 6; i++) {
        if (!r.players[i]) r.players[i] = newPlayer(`机器人${i}`, true).player;
      }
      return afterMutation(r);
    }

    if (!r.started || r.finished) throw new GameError('finished', '本局已结束，请开始下一局', 409);
    if (seat !== r.turn) throw new GameError('not-turn', '还没轮到你', 409);

    if (action === 'pass') {
      if (!r.lead) throw new GameError('no-lead', '当前没有上家牌，不能不要', 400);
      passTurn(r, seat, p.name);
      return afterMutation(r);
    }

    if (action === 'play') {
      const ids = Array.isArray(payload.cards) ? payload.cards.map(String) : [];
      if (new Set(ids).size !== ids.length) throw new GameError('bad-cards', '不能重复选择同一张牌', 400);
      const cards = ids.map((id) => p.hand.find((c) => c.id === id));
      if (!cards.length || cards.some((c) => !c)) throw new GameError('bad-cards', '请选择手牌', 400);
      const move = classify(cards);
      if (!move) throw new GameError('bad-cards', '牌型不符合规则，请重新选牌', 400);
      const target = r.lead && r.lead.seat !== seat ? r.lead : null;
      if (!beats(move, target)) throw new GameError('cannot-beat', '这手牌压不过上家', 400);
      finishCard(r, seat, cards);
      return afterMutation(r);
    }

    throw new GameError('bad-cards', '未知操作', 400);
  }

  function clearTimers(r) {
    if (r._turnTimer) {
      clearTimeout(r._turnTimer);
      r._turnTimer = null;
    }
    if (r._botTimer) {
      clearTimeout(r._botTimer);
      r._botTimer = null;
    }
  }

  function armTurn(r) {
    clearTimers(r);
    if (!r.started || r.finished || r.closed) {
      r.turnDeadline = null;
      return;
    }
    const seat = r.turn;
    const version = r.version;
    const deadline = Date.now() + config.TURN_SECONDS * 1000;
    r.turnDeadline = deadline;
    r._turnTimer = setTimeout(() => onTurnTimeout(r.id, seat, version, deadline), config.TURN_SECONDS * 1000 + 25);
    if (r.players[seat]?.bot) {
      r._botTimer = setTimeout(() => onBot(r.id, seat, version), config.BOT_DELAY_MS);
    }
  }

  function isCurrentTurn(r, seat, version, deadline) {
    return !!r && r.version === version && r.turn === seat && r.turnDeadline === deadline
      && r.started && !r.finished && !!r.players[seat] && !r.players[seat].done;
  }

  function onTurnTimeout(id, seat, version, deadline) {
    const r = rooms.get(id);
    if (!isCurrentTurn(r, seat, version, deadline)) return;
    const p = r.players[seat];
    try {
      if (r.lead) {
        r.log.push(`${p.name} 超时，自动不要`);
        passTurn(r, seat, p.name);
      } else {
        const sorted = [...p.hand].sort((a, b) => a.rank - b.rank || a.suit - b.suit);
        if (!sorted.length) return;
        r.log.push(`${p.name} 超时，自动出最小单张`);
        finishCard(r, seat, [sorted[0]]);
      }
    } catch (e) {
      console.error('timeout action failed', e);
      return;
    }
    afterMutation(r);
  }

  function onBot(id, seat, version) {
    const r = rooms.get(id);
    if (!r || r.version !== version || r.turn !== seat || !r.started || r.finished) return;
    const p = r.players[seat];
    if (!p?.bot || p.done) return;
    try {
      botAct(r);
    } catch (e) {
      console.error('bot action failed', e);
      return;
    }
    afterMutation(r);
  }

  function afterMutation(r) {
    r.version = (r.version || 0) + 1;
    r.lastActivityAt = Date.now();
    armTurn(r);
    if (store) store.scheduleSave(rooms);
    try {
      broadcast(r);
    } catch (e) {
      console.error('broadcast failed', e);
    }
    return r;
  }

  function attachSocket(r, seat, ws) {
    if (!r.sockets.has(seat)) r.sockets.set(seat, new Set());
    r.sockets.get(seat).add(ws);
    touch(r, seat);
    try {
      broadcast(r);
    } catch (e) {
      console.error('presence broadcast failed', e);
    }
  }

  function detachSocket(r, seat, ws) {
    const set = r.sockets.get(seat);
    if (set) {
      set.delete(ws);
      if (!set.size) r.sockets.delete(seat);
    }
    try {
      broadcast(r);
    } catch (e) {
      console.error('presence broadcast failed', e);
    }
  }

  function normalizeHost(r) {
    let h = r.hostSeat;
    if (!(Number.isInteger(h) && h >= 0 && h < 6 && r.players[h] && !r.players[h].bot)) {
      h = r.players.findIndex((p) => p && !p.bot);
      if (h < 0) h = 0;
      r.hostSeat = h;
    }
  }

  function normalizeRoom(rec) {
    if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !/^[0-9A-F]{6}$/.test(rec.id)) {
      throw new Error('bad room record');
    }
    const r = emptyRoom(rec.id);
    const players = Array.isArray(rec.players) ? rec.players.slice(0, 6) : [];
    while (players.length < 6) players.push(null);
    r.players = players.map((p) => (p && typeof p === 'object' ? {
      name: String(p.name || '玩家').slice(0, 12),
      hand: Array.isArray(p.hand) ? p.hand.filter(isCard).map((c) => ({ ...c })) : [],
      bot: !!p.bot,
      done: !!p.done,
      ready: p.ready === undefined ? true : !!p.ready,
      tokenHash: typeof p.tokenHash === 'string' ? p.tokenHash : null,
    } : null));
    const six = (v, dflt) => (Array.isArray(v) && v.length === 6 ? v.slice() : dflt);
    r.teams = six(rec.teams, [0, 1, 0, 1, 0, 1]).map((x) => (x === 1 ? 1 : 0));
    r.positions = six(rec.positions, [0, 1, 2, 3, 4, 5]).map((x) => (Number.isInteger(x) ? x : 0));
    r.playedBy = Array.from({ length: 6 }, (_, i) => (Array.isArray(rec.playedBy?.[i])
      ? rec.playedBy[i].filter(isCard).map((c) => ({ ...c })) : null));
    r.passed = six(rec.passed, Array(6).fill(false)).map(Boolean);
    r.closed = false;
    r.started = !!rec.started;
    r.turn = Number.isInteger(rec.turn) && rec.turn >= 0 && rec.turn < 6 ? rec.turn : 0;
    r.lead = rec.lead && typeof rec.lead === 'object' && Array.isArray(rec.lead.cards) ? { ...rec.lead } : null;
    r.passes = Number(rec.passes) || 0;
    r.finished = !!rec.finished;
    r.bigEmperor = Number.isInteger(rec.bigEmperor) ? rec.bigEmperor : null;
    r.scores = (Array.isArray(rec.scores) && rec.scores.length === 2 ? rec.scores.slice() : [0, 0]).map((x) => Number(x) || 0);
    r.trickPoints = Number(rec.trickPoints) || 0;
    r.gamesPlayed = Number(rec.gamesPlayed) || 0;
    r.bigSet = Number(rec.bigSet) || 1;
    r.matchResults = Array.isArray(rec.matchResults) ? rec.matchResults.slice(-50) : [];
    r.log = Array.isArray(rec.log) ? rec.log.slice(-200).map(String) : [];
    r.windSeq = Number.isInteger(rec.windSeq) ? rec.windSeq : 0;
    r.lastWind = rec.lastWind && Number.isInteger(rec.lastWind.seat)
      ? { seat: rec.lastWind.seat, leader: Number.isInteger(rec.lastWind.leader) ? rec.lastWind.leader : null, seq: Number(rec.lastWind.seq) || 0 }
      : null;
    r.roundWinner = Number.isInteger(rec.roundWinner) ? rec.roundWinner : null;
    r.leftoverPoints = Number(rec.leftoverPoints) || 0;
    r.penalty = Number(rec.penalty) || 0;
    r.version = Number.isInteger(rec.version) ? rec.version : 0;
    r.turnDeadline = typeof rec.turnDeadline === 'number' ? rec.turnDeadline : null;
    r.hostSeat = Number.isInteger(rec.hostSeat) ? rec.hostSeat : 0;
    r.lastActivityAt = Number(rec.lastActivityAt) || Date.now();
    normalizeHost(r);
    return r;
  }

  function restore(records) {
    for (const rec of records || []) {
      try {
        const r = normalizeRoom(rec);
        if (rooms.has(r.id)) continue;
        rooms.set(r.id, r);
      } catch (e) {
        console.error('skip invalid room record', rec && rec.id, e.message);
      }
    }
    for (const r of rooms.values()) resumeTurn(r);
  }

  function resumeTurn(r) {
    clearTimers(r);
    if (!r.started || r.finished) {
      r.turnDeadline = null;
      return;
    }
    if (typeof r.turnDeadline !== 'number') r.turnDeadline = Date.now() + config.TURN_SECONDS * 1000;
    const seat = r.turn;
    const version = r.version;
    const deadline = r.turnDeadline;
    const wait = Math.max(100, deadline - Date.now() + 25);
    r._turnTimer = setTimeout(() => onTurnTimeout(r.id, seat, version, deadline), wait);
    if (r.players[seat]?.bot) {
      r._botTimer = setTimeout(() => onBot(r.id, seat, version), config.BOT_DELAY_MS);
    }
  }

  function cleanup() {
    const now = Date.now();
    const ttl = config.ROOM_TTL_HOURS * 3600 * 1000;
    let changed = false;
    for (const [id, r] of rooms) {
      if (now - (r.lastActivityAt || 0) <= ttl) continue;
      if ([...r.sockets.values()].some((s) => s.size)) continue;
      clearTimers(r);
      rooms.delete(id);
      changed = true;
    }
    if (changed && store) store.scheduleSave(rooms);
  }

  function startCleanup() {
    const t = setInterval(cleanup, 3600 * 1000);
    if (t.unref) t.unref();
    return t;
  }

  return {
    rooms,
    GameError,
    cleanName,
    createRoom,
    joinRoom,
    authorize,
    getRoom,
    findSeatByToken,
    requireSeat,
    isOnline,
    publicState,
    applyAction,
    afterMutation,
    attachSocket,
    detachSocket,
    setBroadcast,
    restore,
    resumeTurn,
    cleanup,
    startCleanup,
    clearTimers,
    hashToken,
  };
}

module.exports = { createEngine, GameError, cleanName };
