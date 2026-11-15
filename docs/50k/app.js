'use strict';
/* 丹东五十K 前端：WebSocket 实时同步、token 会话、全员倒计时、提示与兼容轮询。 */

const $ = (s) => document.querySelector(s);

let roomId = '';
let seat = -1;
let selection = new Set();
let state = null;
let pending = 'create';
let token = '';
let ws = null;
let wsState = 'idle';
let wsRetry = 0;
let wsRetryTimer = null;
let connectWatch = null;
let wsLastMessage = 0;
let pollTimer = null;
let serverSkew = 0;
let lastVersion = -1;
let lastTurnKey = '';
let lastFinished = false;
let pendingAction = null;
let actionWatchdog = null;
let hintIndex = -1;
let hintKey = '';
let hintBreaks = 0;
let muted = false;
let warnedDeadline = null;
let audioCtx = null;
let lastLeadSig = null;
let lastPlaySigs = {};
let connHideTimer = null;
let lastWindSeq = 0;
let windInitialized = false;
let lastResultSig = '';
let lastHandKey = '';

const API_BASE = (window.DANDONG_API_BASE || '').replace(/\/+$/, '');
const ASSET_PREFIX = window.DANDONG_ASSET_PREFIX || '../assets/';
const FACE_V='?v=4';
const jokerFaces={small:ASSET_PREFIX+'joker-small.svg'+FACE_V,big:ASSET_PREFIX+'joker-big.svg'+FACE_V};

const SESSION_KEY = 'dandong50k-session';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const notice = (m) => {
  const t = $('#toast');
  t.textContent = m;
  t.style.opacity = 1;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { t.style.opacity = 0; }, 2200);
};

function myNotice(m) {
  const el = $('#myNotice');
  if (!el) { notice(m); return; }
  el.textContent = m;
  el.classList.add('show');
  clearTimeout(myNotice.timer);
  myNotice.timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function saveSession() {
  if (!roomId || !token) return;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ room: roomId, seat, token })); } catch {}
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (s && typeof s.room === 'string' && typeof s.token === 'string') return s;
  } catch {}
  return null;
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

async function api(path, data = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  let r;
  try {
    r = await fetch(API_BASE + '/api/' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...data, token: token || data.token }),
      signal: ctrl.signal,
    });
  } catch {
    const err = new Error('网络不稳定，请稍后重试');
    err.code = 'network';
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || j.error) {
    const err = new Error(j.error || '操作失败');
    err.code = j.code || '';
    err.status = r.status;
    throw err;
  }
  return j;
}

function openJoin(mode) {
  pending = mode;
  const isJoin = mode === 'join';
  $('#modalTitle').textContent = mode === 'demo' ? '和5个机器人开局' : isJoin ? '加入牌桌' : '创建牌桌';
  $('#modalDesc').textContent = isJoin
    ? '输入房主发给你的 6 位房间码，再填昵称。'
    : mode === 'demo' ? '输入昵称，5 个机器人会自动入座。' : '输入昵称后创建牌桌。';
  const codeInput = $('#roomCode');
  codeInput.style.display = isJoin ? 'block' : 'none';
  if (isJoin) codeInput.value = roomId || '';
  $('#joinModal').style.display = 'grid';
  setTimeout(() => {
    if (isJoin && !codeInput.value) codeInput.focus();
    else $('#nickname').focus();
  }, 60);
}

function showGame() {
  document.body.classList.add('in-game');
  $('#online').style.display = 'flex';
  $('#roomLabel').textContent = '房间码 ' + roomId;
  lockLandscape();
}

function shareBase() {
  // Railway 域名在微信里会被拦，分享时优先给 GitHub Pages 地址。
  if (/(^|\.)railway\.app$/.test(location.hostname)) {
    return 'https://gogogo123-cmd.github.io/dandong-50k/50k/';
  }
  return location.href.split('#')[0];
}

function inviteLink() {
  return shareBase() + '#room=' + roomId;
}

async function copyInvite() {
  if (!roomId) return;
  const text = inviteLink();
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    notice(`邀请链接已复制 · 房间码 ${roomId}`);
  } catch {
    notice(`复制失败，请手动分享房间码 ${roomId}`);
  }
}

function lockLandscape() {
  try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {}
}

function setBanner(text, warn, autoHide) {
  const b = $('#connBanner');
  clearTimeout(connHideTimer);
  if (!text) {
    b.classList.remove('show');
    return;
  }
  b.textContent = text;
  b.classList.toggle('warn', !!warn);
  b.classList.add('show');
  if (autoHide) connHideTimer = setTimeout(() => b.classList.remove('show'), 2000);
}

/* ---------- 牌面与牌型工具（规则与既有界面保持不变） ---------- */

function suitChar(c) {
  return c.rank >= 16 ? (c.rank === 17 ? '★' : '✦') : ['♠', '♥', '♣', '♦'][c.suit];
}

const CARD_SUIT_KEY = { 0: 's', 1: 'h', 2: 'c', 3: 'd' };
const CARD_RANK_KEY = { 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: '11', 12: '12', 13: '13', 14: '14', 15: '15' };
const CARD_RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2' };

// 进牌桌前把全部牌面预加载进内存，避免首轮出牌时一张张下载出现白板。
const PRELOADED_FACES = [];
function preloadCardFaces() {
  const srcs = [jokerFaces.small, jokerFaces.big];
  for (const suit of Object.values(CARD_SUIT_KEY)) {
    for (const rank of Object.values(CARD_RANK_KEY)) srcs.push(`${ASSET_PREFIX}card-${suit}-${rank}.svg`+FACE_V);
  }
  for (const src of srcs) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    PRELOADED_FACES.push(img);
  }
}

function cardHTML(c, selected = false, animate = false) {
  if (c.rank >= 16) {
    return `<div class="card joker-face ${selected ? 'selected' : ''} ${animate ? 'new-move' : ''}" data-id="${c.id}"><img class="joker-art" src="${c.rank === 17 ? jokerFaces.big : jokerFaces.small}" alt="${c.rank === 17 ? '大王' : '小王'}"></div>`;
  }
  const src = `${ASSET_PREFIX}card-${CARD_SUIT_KEY[c.suit]}-${CARD_RANK_KEY[c.rank]}.svg`+FACE_V;
  const label = CARD_RANK_LABEL[c.rank] || c.rank;
  return `<div class="card card-face ${selected ? 'selected' : ''} ${animate ? 'new-move' : ''}" data-id="${c.id}"><img class="card-img" src="${src}" alt="${label}${suitChar(c)}" draggable="false"></div>`;
}

const SUIT_ASC = { 0: 0, 3: 1, 2: 2, 1: 3 }; // ♣ < ♠ < ♦ < ♥

function arrangeHand(cards) {
  const suitOrder = [1, 3, 0, 2], rest = [...cards], pure = [], mixed = [];
  const sortCards = (a, b) => a.rank - b.rank || SUIT_ASC[a.suit] - SUIT_ASC[b.suit] || a.id.localeCompare(b.id);
  const remove = (group) => {
    const ids = new Set(group.map((c) => c.id));
    for (let i = rest.length - 1; i >= 0; i--) if (ids.has(rest[i].id)) rest.splice(i, 1);
  };
  for (const suit of suitOrder) {
    while (true) {
      const group = [5, 10, 13].map((rank) => rest.find((c) => c.rank === rank && c.suit === suit));
      if (group.some((c) => !c)) break;
      pure.push(group);
      remove(group);
    }
  }
  while (true) {
    let best = null;
    for (const a of rest.filter((c) => c.rank === 5)) {
      for (const b of rest.filter((c) => c.rank === 10)) {
        for (const k of rest.filter((c) => c.rank === 13)) {
          const group = [a, b, k];
          if (new Set(group.map((c) => c.suit)).size < 2) continue;
          const score = group.map((c) => SUIT_ASC[c.suit]).sort((x, y) => x - y).join('');
          if (!best || score < best.score) best = { group, score };
        }
      }
    }
    if (!best) break;
    mixed.push(best.group);
    remove(best.group);
  }
  rest.sort(sortCards);
  pure.sort((a, b) => SUIT_ASC[a[0].suit] - SUIT_ASC[b[0].suit]);
  mixed.sort((a, b) => {
    const sa = a.map((c) => SUIT_ASC[c.suit]).sort((x, y) => x - y).join('');
    const sb = b.map((c) => SUIT_ASC[c.suit]).sort((x, y) => x - y).join('');
    return sa.localeCompare(sb);
  });
  // 普通牌从小到大，杂腿在左、纯腿在右。
  return [...rest, ...mixed.flat(), ...pure.flat()];
}

function describe(cards) {
  if (!cards.length) return '未选牌';
  const ranks = cards.map((c) => c.rank), n = cards.length, counts = new Map();
  ranks.forEach((r) => counts.set(r, (counts.get(r) || 0) + 1));
  if (n === 2 && ranks[0] === ranks[1] && ranks[0] >= 16) return ranks[0] === 17 ? '一对大王' : '一对小王';
  if (n === 3 && ranks.every((r) => r === ranks[0]) && ranks[0] >= 16) return '三王';
  if (n === 3 && [5, 10, 13].every((r) => counts.get(r) === 1)) return new Set(cards.map((c) => c.suit)).size === 1 ? '纯腿' : '杂腿';
  if (n >= 3 && counts.size === 1) return `${n}张炸弹`;
  if (n >= 6 && n % 2 === 0 && [...counts.values()].every((v) => v === 2)) {
    const q = [...counts.keys()].sort((a, b) => a - b);
    if (q.every((x, i) => x >= 5 && x <= 14 && (!i || x === q[i - 1] + 1))) return '双顺';
  }
  if (n >= 3 && counts.size === n) {
    const q = [...ranks].sort((a, b) => a - b);
    if (q.every((x, i) => x >= 5 && x <= 14 && (!i || x === q[i - 1] + 1))) return '顺子';
  }
  if (counts.size === 1) return n === 1 ? '单张' : n === 2 ? '对子' : n === 3 ? '三张' : '不成牌型';
  return '不成牌型';
}

function rankPower(kind) {
  return ({ ordinary: 0, single: 0, pair: 0, triple: 0, straight: 0, doubleStraight: 0, bomb: 1, mixedLeg: 2, king2: 3, pureLeg: 4, king3: 5 })[kind] ?? -1;
}

function getType(cards) {
  const n = cards.length, rs = cards.map((c) => c.rank), ss = cards.map((c) => c.suit), count = new Map();
  rs.forEach((r) => count.set(r, (count.get(r) || 0) + 1));
  if (n === 3 && rs.every((r) => r === rs[0]) && rs[0] >= 16) return { kind: 'king3', power: rs[0], n };
  if (n === 2 && rs.every((r) => r === rs[0]) && rs[0] >= 16) return { kind: 'king2', power: rs[0], n };
  if (n === 3 && [5, 10, 13].every((r) => count.get(r) === 1)) {
    const pure = new Set(ss).size === 1;
    return { kind: pure ? 'pureLeg' : 'mixedLeg', power: pure ? ({ 1: 4, 3: 3, 0: 2, 2: 1 }[ss[0]]) : 0, n };
  }
  if (n >= 3 && count.size === 1) return { kind: 'bomb', power: rs[0], n };
  if (n >= 6 && n % 2 === 0 && [...count.values()].every((v) => v === 2)) {
    const q = [...count.keys()].sort((a, b) => a - b);
    if (q.every((r, i) => r >= 5 && r <= 14 && (!i || r === q[i - 1] + 1))) return { kind: 'doubleStraight', power: q.at(-1), n };
  }
  if (n >= 3 && count.size === n) {
    const q = [...rs].sort((a, b) => a - b);
    if (q.every((r, i) => r >= 5 && r <= 14 && (!i || r === q[i - 1] + 1))) return { kind: 'straight', power: q.at(-1), n };
  }
  if (count.size === 1) return { kind: n === 1 ? 'single' : n === 2 ? 'pair' : 'triple', power: rs[0], n };
  return null;
}

function canBeat(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (a.kind !== b.kind) {
    if (a.kind === 'mixedLeg' && ['bomb', 'straight', 'doubleStraight'].includes(b.kind)) return true;
    if (b.kind === 'mixedLeg' && ['bomb', 'straight', 'doubleStraight'].includes(a.kind)) return false;
    return rankPower(a.kind) > rankPower(b.kind);
  }
  if (a.kind === 'bomb') return a.n > b.n || (a.n === b.n && a.power > b.power);
  if (['pureLeg', 'mixedLeg', 'king2', 'king3'].includes(a.kind)) return a.power > b.power;
  return a.n === b.n && a.power > b.power;
}

/* ---------- 提示 ---------- */

function breakCostOf(cards, hand) {
  const total = new Map();
  for (const c of hand) total.set(c.rank, (total.get(c.rank) || 0) + 1);
  const used = new Map();
  for (const c of cards) used.set(c.rank, (used.get(c.rank) || 0) + 1);
  let cost = 0;
  for (const [rank, u] of used) {
    const t = total.get(rank) || 0;
    if (t < 2 || u >= t) continue;
    if (rank >= 16) cost += 10; // 双王/三王
    else if (t >= 3) cost += 10; // 炸弹
    else cost += 1; // 对子
  }
  // 五十K：不要拆开完整的纯腿/杂腿
  for (let suit = 0; suit < 4; suit++) {
    const has = [5, 10, 13].every((r) => hand.some((c) => c.rank === r && c.suit === suit));
    if (!has) continue;
    const usedInSuit = cards.filter((c) => c.suit === suit && (c.rank === 5 || c.rank === 10 || c.rank === 13)).length;
    if (usedInSuit > 0 && usedInSuit < 3) cost += 10;
  }
  const hasMixed = [5, 10, 13].every((r) => (total.get(r) || 0) > 0);
  if (hasMixed) {
    const usedRanks = [5, 10, 13].filter((r) => (used.get(r) || 0) > 0).length;
    if (usedRanks > 0 && usedRanks < 3) cost += 5;
  }
  return cost;
}

function buildHints(s) {
  const hand = s.hand || [];
  const target = s.lead && s.lead.seat !== seat ? s.lead : null;
  const out = [];
  const seen = new Set();
  const push = (cs) => {
    if (!cs || !cs.length) return;
    const key = cs.map((c) => c.id).sort().join(',');
    if (seen.has(key)) return;
    const type = getType(cs);
    if (!type || !canBeat(type, target)) return;
    seen.add(key);
    out.push({ cards: cs, type, breaks: breakCostOf(cs, hand), sum: cs.reduce((x, c) => x + c.rank, 0) });
  };

  for (const c of hand) push([c]);

  const byRank = new Map();
  for (const c of hand) {
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  for (const g of byRank.values()) for (let n = 2; n <= g.length; n++) push(g.slice(0, n));

  for (const a of hand.filter((c) => c.rank === 5)) {
    for (const b of hand.filter((c) => c.rank === 10)) {
      for (const k of hand.filter((c) => c.rank === 13)) push([a, b, k]);
    }
  }

  const ranks = [...byRank.keys()].filter((r) => r >= 5 && r <= 14).sort((a, b) => a - b);
  let seq = [];
  const flushSeq = () => {
    if (seq.length >= 3) {
      for (let len = 3; len <= seq.length; len++) {
        for (let i = 0; i + len <= seq.length; i++) {
          const part = seq.slice(i, i + len);
          push(part.map((r) => byRank.get(r)[0]));
          if (part.every((r) => byRank.get(r).length >= 2)) push(part.flatMap((r) => byRank.get(r).slice(0, 2)));
        }
      }
    }
    seq = [];
  };
  for (const r of ranks) {
    if (seq.length && r !== seq[seq.length - 1] + 1) flushSeq();
    seq.push(r);
  }
  flushSeq();

  // 优先不拆对子/三张/炸弹；同代价时先普通牌型、再由小到大。
  out.sort((a, b) => a.breaks - b.breaks
    || rankPower(a.type.kind) - rankPower(b.type.kind)
    || a.type.n - b.type.n
    || (a.type.power ?? 0) - (b.type.power ?? 0)
    || a.sum - b.sum);
  return out;
}

/* ---------- 声音 ---------- */

function ensureAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}

function beep(kind) {
  if (muted) return;
  try {
    ensureAudio();
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    const freqs = kind === 'turn' ? [660, 880] : kind === 'warn' ? [440, 440] : [523, 659, 784];
    freqs.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.09, now + i * 0.12 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.13);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + i * 0.12);
      o.stop(now + i * 0.12 + 0.15);
    });
  } catch {}
}

function updateSoundToggle() {
  const b = $('#soundToggle');
  if (!b) return;
  b.textContent = muted ? '🔇' : '🔊';
  b.classList.toggle('off', muted);
  b.title = muted ? '点击开启提示音' : '点击静音';
}

/* ---------- 状态应用与渲染 ---------- */

function applyState(s, serverNow) {
  if (!s) return;
  if (typeof s.version === 'number' && lastVersion >= 0 && s.version < lastVersion) return;
  if (s.closed) {
    notice('房间已解散');
    goHome();
    return;
  }
  if (Number.isInteger(s.yourSeat) && s.yourSeat >= 0 && Array.isArray(s.players) && s.players[s.yourSeat]) {
    seat = s.yourSeat;
  }
  if (seat >= 0 && Array.isArray(s.players) && s.players[seat] == null) {
    notice('你已离开或被移出房间');
    goHome();
    return;
  }
  if (typeof s.serverNow === 'number') serverSkew = s.serverNow - Date.now();
  else if (typeof serverNow === 'number') serverSkew = serverNow - Date.now();
  if (typeof s.version === 'number') lastVersion = s.version;

  if (s.hand) {
    for (const id of [...selection]) if (!s.hand.some((c) => c.id === id)) selection.delete(id);
  }

  const turnKey = `${s.turn}:${s.turnDeadline}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    hintIndex = -1;
    hintKey = '';
    hintBreaks = 0;
    if (s.started && !s.finished && s.turn === seat) beep('turn');
  }
  if (s.finished && !lastFinished) beep('end');
  lastFinished = !!s.finished;

  state = s;
  render(s);
  updateCountdown();
  checkWind(s);
}

function checkWind(s) {
  const wind = s.lastWind;
  if (!windInitialized) {
    windInitialized = true;
    lastWindSeq = wind && Number.isInteger(wind.seq) ? wind.seq : 0;
    return;
  }
  if (!wind || !Number.isInteger(wind.seq)) return;
  if (wind.seq === lastWindSeq) return;
  lastWindSeq = wind.seq;
  const name = wind.seat === seat ? '你' : (s.players?.[wind.seat]?.name || '玩家');
  const el = $('#windBanner');
  if (el) {
    el.textContent = `接风 · ${name} 接手出牌`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(checkWind.timer);
    checkWind.timer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  const seatEl = wind.seat === seat
    ? $('#mySeat')
    : document.querySelector(`#players .player-seat[data-seat="${wind.seat}"]`);
  if (seatEl) {
    seatEl.classList.add('wind-hit');
    setTimeout(() => seatEl.classList.remove('wind-hit'), 1800);
  }
}

function playSig(cards) {
  return cards && cards.length ? cards.map((c) => c.id).join(',') : '';
}

function busy() {
  return !!pendingAction;
}

function cardStackHTML(count) {
  const n = Math.max(0, Math.min(16, Math.ceil((Number(count) || 0) * 0.7)));
  if (!n) return '';
  let layers = '';
  for (let k = 0; k < n; k++) {
    layers += `<i style="transform:translate(${(k * 0.6).toFixed(1)}px,${(-k * 1.0).toFixed(1)}px)"></i>`;
  }
  return `<span class="card-stack">${layers}</span>`;
}

function render(s) {
  if (!s) return;
  state = s;
  document.body.classList.toggle('lobby-mode', !s.started);

  $('#setLabel').textContent = `大局${s.bigSet || 1} · 小局${Math.min((s.gamesPlayed || 0) + 1, 3)}/3`;

  const leaveBtn = $('#leaveGame');
  if (leaveBtn) {
    const showLeave = s.started || (s.players || []).some((p) => p && p.bot);
    leaveBtn.style.display = showLeave ? 'inline-block' : 'none';
  }
  const dissolveBtn = $('#dissolveGame');
  if (dissolveBtn) {
    dissolveBtn.style.display = s.started && seat === s.hostSeat ? 'inline-block' : 'none';
  }

  const myTurn = s.started && !s.finished && s.turn === seat;
  const lead = s.lead;
  const target = lead && lead.seat !== seat ? { kind: lead.kind, power: lead.power, n: lead.n } : null;
  const current = s.players?.[s.turn];

  if (!s.started) {
    renderLobby(s);
  } else {
    let turnText = s.finished ? '本小局结束' : myTurn ? '轮到你出牌' : `轮到${current?.name || '玩家'}出牌`;
    if (myTurn) turnText += target ? ' · 超时自动不要' : ' · 超时自动出最小牌';
    const history = (s.matchResults || []).map((x) => `<span class="result-chip">第${x.round}局 <b>红 ${x.red} : 蓝 ${x.blue}</b></span>`).join('');
    $('#trickCenter').innerHTML = `<div class="score-panel">
      <div class="score-line"><span class="score-side red">红队 <b>${s.scores?.[0] ?? 0}</b></span><span class="round-points">本轮 <b>${s.trickPoints ?? 0}</b> 分</span><span class="score-side blue">蓝队 <b>${s.scores?.[1] ?? 0}</b></span></div>
      ${history ? `<div class="score-history">${history}</div>` : ''}
      <div class="turn-message">${esc(turnText)}</div>
    </div>`;
  }

  const prevSigs = lastPlaySigs || {};
  const newSigs = {};
  const myTeam = s.players?.[seat]?.team;
  $('#players').innerHTML = (s.players || []).map((p, i) => {
    if (!p) return '';
    const isMe = i === seat;
    if (isMe) return '';
    const rel = isMe ? 0 : ((s.positions?.[i] ?? i) - (s.positions?.[seat] ?? seat) + 6) % 6;
    const active = s.started && !s.finished && s.turn === i;
    const crown = s.bigEmperor === i ? '<span class="crown">👑</span>' : '';
    const count = p.count ?? p.hand?.length ?? 0;
    const stack = s.started && !p.done && !isMe ? cardStackHTML(count) : '';
    const avatar = `${crown}${p.bot ? '🤖' : esc((p.name || '玩家').slice(0, 1))}${stack}`;
    const psig = playSig(p.lastPlay);
    newSigs[i] = psig;
    const animate = psig && psig !== prevSigs[i];
    const online = p.bot ? '' : `<span class="online-dot ${p.online ? '' : 'off'}" title="${p.online ? '在线' : '离线'}"></span>`;
    const host = i === s.hostSeat ? '<span class="host-tag">房主</span>' : '';
    let meta;
    if (isMe) meta = `你 · ${esc(p.team)}${active ? ' · 出牌中' : ''}`;
    else if (!s.started) meta = `${online}${esc(p.team)} · ${p.bot ? '机器人' : p.ready ? '已准备' : '未准备'}`;
    else if (p.done) meta = '已出完';
    else meta = `${online}${esc(p.team)}${active ? ' · 出牌中' : ''}`;
    const aura = myTeam && p.team !== myTeam ? 'play-enemy' : 'play-mate';
    let play = '';
    if (s.started && !s.finished && !isMe) {
      const timer = active ? '<span class="seat-timer show play-timer">--</span>' : '';
      // 出完最后一手但本轮还没结束（未给风/未收分）时，先保留这手牌。
      const holdingLead = p.done && !!s.lead;
      if (p.done && !holdingLead) play = `<div class="player-play play-done ${aura}"><span class="pass-pill done-pill">已出完</span></div>`;
      else if (!p.done && s.passed?.[i]) play = `<div class="player-play play-pass ${aura}">${timer}<span class="pass-pill">不要</span></div>`;
      else if (p.lastPlay?.length) play = `<div class="player-play ${aura}">${timer}${p.lastPlay.map((c) => cardHTML(c, false, animate)).join('')}</div>`;
      else if (active) play = `<div class="player-play play-turn ${aura}">${timer}</div>`;
    }
    return `<div class="player-seat spot-${rel} ${active ? 'active' : ''} ${p.team === '蓝队' ? 'team-blue' : 'team-red'}${isMe ? ' is-me' : ''}" data-seat="${i}"><div class="seat-head"><div class="avatar">${avatar}</div><span class="seat-name">${esc(p.name)}${host}</span></div><div class="seat-meta">${meta}</div>${play}</div>`;
  }).join('');

  const mine = s.players?.[seat]?.lastPlay;
  const mySig = playSig(mine);
  const myPass = s.passed?.[seat];
  const myDone = !!s.players?.[seat]?.done;
  const myHoldingLead = myDone && !!s.lead;
  newSigs[`me:${seat}`] = mySig;
  const myPlayEl = $('#myPlay');
  if (s.started && !s.finished && !myTurn && (myDone || myPass || mine?.length)) {
    myPlayEl.style.display = 'flex';
    myPlayEl.className = `my-play play-mate${myDone && !myHoldingLead ? ' play-done' : myPass ? ' play-pass' : ''}`;
    const myAnimate = !!mySig && mySig !== prevSigs[`me:${seat}`];
    myPlayEl.innerHTML = myDone && !myHoldingLead
      ? '<span class="pass-pill done-pill">已出完</span>'
      : myPass ? '<span class="pass-pill">不要</span>' : (mine || []).map((c) => cardHTML(c, false, myAnimate)).join('');
  } else {
    myPlayEl.style.display = 'none';
    myPlayEl.innerHTML = '';
  }
  lastPlaySigs = newSigs;

  // 自己的头像固定在自己的操作行、倒计时左侧。
  const meP = s.players?.[seat];
  const mySeatEl = $('#mySeat');
  if (mySeatEl) {
    const showMe = s.started && !s.finished && meP;
    mySeatEl.style.display = showMe ? 'flex' : 'none';
    if (showMe) {
      const crownMe = s.bigEmperor === seat ? '<span class="crown">👑</span>' : '';
      mySeatEl.className = `my-seat ${meP.team === '蓝队' ? 'team-blue' : 'team-red'}${myTurn ? ' active' : ''}${meP.done ? ' done' : ''}`;
      mySeatEl.innerHTML = `<div class="avatar">${crownMe}${esc((meP.name || '我').slice(0, 1))}</div>`;
      mySeatEl.title = `${meP.name || '我'} · ${meP.team}`;
    } else {
      mySeatEl.innerHTML = '';
    }
  }

  const hand = arrangeHand(s.hand || []);
  const handKey = `${hand.map((c) => c.id).join(',')}|${[...selection].sort().join(',')}`;
  if (handKey !== lastHandKey) {
    lastHandKey = handKey;
    $('#myHand').innerHTML = hand.map((c) => cardHTML(c, selection.has(c.id))).join('');
    fitHand();
  }

  const chosen = (s.hand || []).filter((c) => selection.has(c.id));
  const type = getType(chosen);
  const canPlayNow = !!(type && canBeat(type, target));
  $('#playCards').disabled = busy() || !myTurn || !canPlayNow;
  $('#passTurn').disabled = busy() || !myTurn || !target;
  $('#hint').disabled = busy() || !myTurn;

  renderProfile(s);

  const hintText = !myTurn ? '等待其他玩家'
    : chosen.length ? `已选：${describe(chosen)}${canPlayNow ? ' · 可以出牌' : type ? ' · 压不过上家' : ' · 牌型不成立'}`
    : target ? '选牌压上家，或不要' : '选一手合法牌型';
  $('#actionHint').textContent = myTurn && hintBreaks > 0 ? `${hintText} · 需拆牌` : hintText;

  const bar = $('#actionBar');
  if (!s.started) {
    bar.style.display = 'none';
    bar.classList.remove('turn-on');
  } else {
    bar.style.display = '';
    bar.classList.toggle('turn-on', myTurn);
  }
  $('#gameLog').textContent = (s.log || []).slice(-3).join('　·　');

  const modal = $('#roundModal');
  modal.classList.toggle('show', !!s.finished);
  if (!s.finished) lastResultSig = '';
  if (s.finished) {
    renderRoundResult(s);
    const emperorTeam = s.bigEmperor === null || s.bigEmperor === undefined ? null : s.players?.[s.bigEmperor]?.team;
    $('#roundTitle').textContent = (s.gamesPlayed || 0) >= 3 ? `大局${s.bigSet}结束` : `第${s.gamesPlayed}小局结束`;
    $('#roundDetail').textContent = `${s.roundWinner === null ? '本小局平局' : `${s.roundWinner === 0 ? '红队' : '蓝队'}获胜`} · 未出手分牌 ${s.leftoverPoints || 0} 分转给对方 · 非大皇队扣分 ${s.penalty || 0} 分 · 大皇${emperorTeam ? `（${emperorTeam}）` : '未产生'}`;
    const rows = s.matchResults || [];
    let totalRed = 0, totalBlue = 0, totalLeft = 0, totalPen = 0;
    rows.forEach((x) => {
      totalRed += x.red || 0;
      totalBlue += x.blue || 0;
      totalLeft += x.leftover || 0;
      totalPen += x.penalty || 0;
    });
    $('#roundSummary').innerHTML = '<div class="result-row header"><span>小局</span><span>红队</span><span>蓝队</span><span>胜队</span><span>未出手分</span><span>扣分</span></div>'
      + rows.map((x) => `<div class="result-row"><span>第${x.round}局</span><span>${x.red}</span><span>${x.blue}</span><span class="winner">${x.winner === null ? '平局' : x.winner === 0 ? '红队' : '蓝队'}</span><span>${x.leftover || 0}</span><span>${x.penalty || 0}</span></div>`).join('')
      + `<div class="result-row total"><span>合计</span><span>${totalRed}</span><span>${totalBlue}</span><span>—</span><span>${totalLeft}</span><span>${totalPen}</span></div>`;
    const remaining = (s.players || []).map((p, i) => ({ p, i }))
      .filter(({ p }) => p && Array.isArray(p.remaining) && p.remaining.length);
    $('#roundHands').innerHTML = remaining.length
      ? `<div class="reveal-title">未出完手牌</div>` + remaining.map(({ p, i }) => {
        const cards = arrangeHand(p.remaining);
        const pts = cards.reduce((sum, c) => sum + (c.rank === 5 ? 5 : (c.rank === 10 || c.rank === 13 ? 10 : 0)), 0);
        return `<div class="reveal-row ${p.team === '蓝队' ? 'team-blue' : 'team-red'}"><div class="reveal-name">${i === seat ? '你' : esc(p.name)}<small>${esc(p.team)} · 剩 ${cards.length} 张 · ${pts} 分</small></div><div class="reveal-cards">${cards.map((c) => cardHTML(c)).join('')}</div></div>`;
      }).join('')
      : '<div class="reveal-none">所有玩家均已出完</div>';
    const nextBtn = $('#nextGame');
    const bigDone = (s.gamesPlayed || 0) >= 3;
    const hostNow = seat === s.hostSeat;
    nextBtn.style.display = 'inline-block';
    nextBtn.disabled = busy() || (bigDone && !hostNow);
    nextBtn.textContent = bigDone
      ? (hostNow ? '随机分组，开始新大局' : '等待房主随机分组')
      : `开始第${(s.gamesPlayed || 0) + 1}小局`;
  }
}

function renderRoundResult(s) {
  const el = $('#roundResult');
  if (!el) return;
  const winner = s.roundWinner;
  const red = s.scores?.[0] ?? 0;
  const blue = s.scores?.[1] ?? 0;
  const kind = winner === null || winner === undefined ? 'draw' : winner === 0 ? 'red' : 'blue';
  const label = kind === 'draw' ? '平局' : kind === 'red' ? '红队获胜' : '蓝队获胜';
  el.className = `round-result ${kind}`;
  el.innerHTML = `<b>${label}</b><span>红 ${red} : ${blue} 蓝</span>`;
  const sig = `${s.gamesPlayed}:${kind}:${red}:${blue}`;
  if (sig === lastResultSig) return;
  lastResultSig = sig;
  spawnConfetti(kind);
}

function spawnConfetti(kind) {
  const box = $('#roundConfetti');
  if (!box) return;
  box.innerHTML = '';
  const colors = kind === 'red'
    ? ['#ff6b61', '#d34a43', '#ffd166', '#ffe9d6']
    : kind === 'blue'
      ? ['#6eaed7', '#3d7fb5', '#ffd166', '#dff2ff']
      : ['#e9c47a', '#b7cec3', '#f5efdf'];
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('i');
    const left = Math.random() * 100;
    const delay = Math.random() * 0.7;
    const dx = (Math.random() * 160 - 80).toFixed(0);
    const dur = (1.4 + Math.random() * 1.1).toFixed(2);
    piece.style.cssText = `left:${left.toFixed(1)}%;background:${colors[i % colors.length]};`
      + `--dx:${dx}px;animation-delay:${delay.toFixed(2)}s;animation-duration:${dur}s;`
      + `width:${(5 + Math.random() * 5).toFixed(0)}px;height:${(9 + Math.random() * 8).toFixed(0)}px`;
    box.appendChild(piece);
  }
  clearTimeout(spawnConfetti.timer);
  spawnConfetti.timer = setTimeout(() => { box.innerHTML = ''; }, 3200);
}

/* ---------- 大厅 / 个人信息 / 手牌排版 ---------- */

function renderLobby(s) {
  const players = s.players || [];
  const occupied = players.filter(Boolean).length;
  const ready = players.filter((p) => p && p.ready).length;
  const isHost = seat === s.hostSeat;
  const me = players[seat];
  const rows = players.map((p, i) => {
    const team = i % 2 ? '蓝队' : '红队';
    if (!p) {
      const btns = [];
      if (isHost) btns.push(`<button class="mini-btn" data-lobby="addbot" data-seat="${i}" type="button">+机器人</button>`);
      btns.push(`<button class="mini-btn" data-lobby="sit" data-seat="${i}" type="button">坐这里</button>`);
      return `<div class="lobby-row empty"><span class="lobby-seat">${i + 1}号位</span><span class="lobby-name">空位 <i>${team}</i></span><span class="lobby-state">${btns.join('')}</span></div>`;
    }
    const tags = [i === seat ? '你' : '', i === s.hostSeat ? '房主' : '', p.bot ? '机器人' : '', p.team].filter(Boolean).join(' · ');
    const stateText = p.ready ? '<b class="ok">已准备</b>' : '<b class="no">未准备</b>';
    let manage = '';
    if (isHost && i !== seat) {
      if (p.bot) manage = `<button class="mini-btn" data-lobby="removebot" data-seat="${i}" type="button">移除</button>`;
      else if (!p.ready) manage = `<button class="mini-btn" data-lobby="kick" data-seat="${i}" type="button">踢出</button>`;
    }
    return `<div class="lobby-row ${i === seat ? 'mine' : ''} ${p.team === '蓝队' ? 'team-blue' : 'team-red'}"><span class="lobby-seat">${i + 1}号位</span><span class="lobby-name">${esc(p.name)}${tags ? `<i>${tags}</i>` : ''}</span><span class="lobby-state">${stateText}${manage}</span></div>`;
  }).join('');
  const actions = isHost
    ? `<button class="btn primary" data-lobby="start" type="button" ${s.canStart ? '' : 'disabled'}>开始游戏</button><button class="btn" data-lobby="dissolve" type="button">解散房间</button>`
    : `<button class="btn primary" data-lobby="ready" type="button">${me?.ready ? '取消准备' : '准备'}</button><button class="btn" data-lobby="leave" type="button">退出房间</button>`;
  const hint = isHost
    ? (s.canStart ? '所有玩家已准备，可以开始' : '空位可逐个加机器人，也可换到空位；6 人准备后开始')
    : (me?.ready ? '已准备，等待房主开始' : '准备后等待房主开始');
  $('#trickCenter').innerHTML = `<div class="lobby-panel">
    <div class="lobby-title">候场大厅</div>
    <div class="lobby-count">入座 ${occupied}/6 · 已准备 ${ready}/6</div>
    <div class="lobby-code" data-lobby="copy" role="button" title="点击复制邀请链接">房间码 <b>${esc(s.id)}</b> · 点击复制邀请链接</div>
    <div class="lobby-list">${rows}</div>
    <div class="lobby-actions">${actions}</div>
    <div class="lobby-hint">${hint}</div>
  </div>`;
}

function renderProfile() {
  const el = $('#myProfile');
  if (!el) return;
  el.style.display = 'none';
  el.innerHTML = '';
}

function fitHand() {
  const row = $('#myHand');
  if (!row) return;
  const cards = [...row.querySelectorAll('.card')];
  for (const el of cards) el.style.marginLeft = '';
  if (cards.length < 2) return;
  const container = row.parentElement;
  if (!container) return;
  const cs = getComputedStyle(container);
  const avail = container.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const cardW = cards[0].getBoundingClientRect().width
    || parseFloat(getComputedStyle(cards[0]).width) || 0;
  if (!avail || !cardW) return;
  // 以满手 23 张为基准固定牌距；牌变少时不重新铺开。
  const overlap = cardW >= 56 ? 18 : 12;
  const fitStep = (avail - cardW) / 22;
  const step = Math.max(8, Math.min(cardW - overlap, fitStep));
  for (let i = 1; i < cards.length; i++) cards[i].style.marginLeft = `${step - cardW}px`;
}

function bindHandPointer() {
  const handEl = $('#myHand');
  if (!handEl) return;
  let dragging = false, moved = false, mode = false, startCard = null, lastId = '', startX = 0, startY = 0;
  const apply = (id, on) => {
    if (on) selection.add(id); else selection.delete(id);
    for (const el of handEl.querySelectorAll('.card')) {
      if (el.dataset.id === id) el.classList.toggle('selected', on);
    }
  };
  handEl.addEventListener('pointerdown', (e) => {
    if (busy() || !state || !state.started || state.finished) return;
    const card = e.target.closest('.card');
    if (!card || !handEl.contains(card)) return;
    e.preventDefault();
    dragging = true;
    moved = false;
    startCard = card;
    lastId = card.dataset.id;
    startX = e.clientX;
    startY = e.clientY;
    mode = !selection.has(lastId);
  });
  handEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    if (!moved) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) <= 6) return;
      moved = true;
      apply(lastId, mode);
    }
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    const card = hit && hit.closest ? hit.closest('.card') : null;
    if (!card || !handEl.contains(card)) return;
    const id = card.dataset.id;
    if (id === lastId) return;
    lastId = id;
    apply(id, mode);
    e.preventDefault();
  });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (!moved && startCard) {
      const id = startCard.dataset.id;
      selection.has(id) ? selection.delete(id) : selection.add(id);
    }
    hintBreaks = 0;
    startCard = null;
    if (state) render(state);
  };
  handEl.addEventListener('pointerup', finish);
  handEl.addEventListener('pointercancel', finish);
}

function goHome() {
  try { if (ws) ws.close(); } catch {}
  ws = null;
  wsState = 'idle';
  stopPolling();
  clearTimeout(wsRetryTimer);
  wsRetryTimer = null;
  clearTimeout(connectWatch);
  clearTimeout(actionWatchdog);
  pendingAction = null;
  roomId = '';
  seat = -1;
  token = '';
  selection.clear();
  state = null;
  lastVersion = -1;
  lastLeadSig = null;
  lastPlaySigs = {};
  hintIndex = -1;
  hintKey = '';
  hintBreaks = 0;
  lastTurnKey = '';
  lastFinished = false;
  lastWindSeq = 0;
  windInitialized = false;
  lastResultSig = '';
  lastHandKey = '';
  clearSession();
  document.body.classList.remove('in-game');
  document.body.classList.remove('lobby-mode');
  const online = $('#online');
  if (online) online.style.display = 'none';
  const modal = $('#joinModal');
  if (modal) modal.style.display = 'none';
  const round = $('#roundModal');
  if (round) round.classList.remove('show');
  const profile = $('#myProfile');
  if (profile) profile.innerHTML = '';
  history.replaceState(null, '', location.pathname + location.search);
  setBanner('', false, false);
}

/* ---------- 倒计时 ---------- */

function remainingSeconds() {
  if (!state || !state.started || state.finished || typeof state.turnDeadline !== 'number') return null;
  return Math.max(0, (state.turnDeadline - (Date.now() + serverSkew)) / 1000);
}

function updateCountdown() {
  const rem = remainingSeconds();
  const show = rem !== null;
  const sec = show ? Math.max(0, Math.ceil(rem - 0.001)) : 0;
  const low = show && rem <= 10;

  const timer = $('#turnTimer');
  if (timer) {
    timer.classList.toggle('show', show);
    timer.classList.toggle('low', low);
    if (show) timer.textContent = `⏱ ${sec}s`;
  }

  const mine = show && state.turn === seat;
  const myTimer = $('#myTimer');
  myTimer.classList.toggle('show', mine);
  myTimer.classList.toggle('low', mine && low);
  if (mine) myTimer.textContent = `${sec}s`;
  myTimer.title = mine ? (state.lead && state.lead.seat !== seat ? '超时自动不要' : '超时自动出最小牌') : '你的出牌倒计时';

  document.querySelectorAll('#players .seat-timer').forEach((el) => {
    el.textContent = show ? `${sec}s` : '';
    el.classList.toggle('low', low);
  });

  if (mine && rem !== null && rem <= 10 && state.turnDeadline !== warnedDeadline) {
    warnedDeadline = state.turnDeadline;
    beep('warn');
  }
}

setInterval(updateCountdown, 250);

/* ---------- 操作（防连点 + WS ack 对账） ---------- */

function beginAction(meta, requestId) {
  pendingAction = { meta, requestId, startedAt: Date.now() };
  clearTimeout(actionWatchdog);
  actionWatchdog = setTimeout(() => {
    if (!pendingAction) return;
    pendingAction = null;
    notice('操作超时，请重试');
    if (state) render(state);
  }, 10000);
  if (state) render(state);
}

function finishAction(requestId, ok, message) {
  const pp = pendingAction;
  if (!pp) return;
  if (requestId != null && pp.requestId !== requestId) return;
  clearTimeout(actionWatchdog);
  pendingAction = null;
  if (ok && pp.meta?.clearSelection) selection.clear();
  if (!ok && message) notice(message);
  if (state) render(state);
}

async function restAction(action, extra, meta) {
  beginAction(meta, null);
  try {
    const r = await api(action, { room: roomId, token, ...extra });
    if (r.state) applyState(r.state, r.serverNow);
    if (r.room) roomId = r.room;
    if (typeof r.seat === 'number') seat = r.seat;
    if (r.token) token = r.token;
    saveSession();
    finishAction(null, true);
    return r;
  } catch (e) {
    finishAction(null, false, e.message);
    if (e.code === 'auth') handleAuthFailure(e);
    throw e;
  }
}

function sendAction(action, extra = {}, meta = {}) {
  if (busy()) return false;
  if (ws && ws.readyState === WebSocket.OPEN && wsState === 'open') {
    const requestId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    beginAction(meta, requestId);
    try {
      ws.send(JSON.stringify({ type: 'action', action, requestId, ...extra }));
      return true;
    } catch {
      pendingAction = null;
      clearTimeout(actionWatchdog);
    }
  }
  restAction(action, extra, meta).catch(() => {});
  return true;
}

/* ---------- WebSocket ---------- */

function wsUrl() {
  if (API_BASE) {
    const u = new URL(API_BASE);
    return (u.protocol === 'https:' ? 'wss://' : 'ws://') + u.host + '/ws';
  }
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

function scheduleReconnect() {
  if (wsRetryTimer || !roomId || !token) return;
  const base = Math.min(8000, 500 * Math.pow(2, wsRetry));
  wsRetry += 1;
  const wait = base + Math.random() * 300;
  wsRetryTimer = setTimeout(() => {
    wsRetryTimer = null;
    connectWS();
  }, wait);
}

function handleAuthFailure(e) {
  if (!roomId) return;
  token = '';
  clearSession();
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  wsState = 'failed';
  stopPolling();
  setBanner('身份已失效，请重新加入', true, false);
  notice(e?.message || '身份验证失败，请重新加入');
  openJoin('join');
}

function connectWS() {
  if (!roomId || !token) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(wsRetryTimer);
  wsRetryTimer = null;
  clearTimeout(connectWatch);
  wsState = 'connecting';
  setBanner('', false, false);

  let sock;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    wsState = 'closed';
    startPolling();
    scheduleReconnect();
    return;
  }
  ws = sock;

  connectWatch = setTimeout(() => {
    if (wsState !== 'open') startPolling();
  }, 4000);

  sock.onopen = () => {
    wsLastMessage = Date.now();
    try { sock.send(JSON.stringify({ type: 'hello', room: roomId, token })); } catch {}
  };

  sock.onmessage = (ev) => {
    wsLastMessage = Date.now();
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m !== 'object') return;

    if (m.type === 'hello') {
      if (m.ok) {
        wsState = 'open';
        wsRetry = 0;
        clearTimeout(connectWatch);
        if (typeof m.seat === 'number') seat = m.seat;
        if (m.room) roomId = m.room;
        saveSession();
        stopPolling();
        lastVersion = -1;
        applyState(m.state, m.serverNow);
        setBanner('', false, false);
      } else {
        handleAuthFailure(new Error(m.message || '身份验证失败，请重新加入'));
      }
      return;
    }
    if (m.type === 'state') {
      wsState = 'open';
      applyState(m.state, m.serverNow);
      return;
    }
    if (m.type === 'removed') {
      notice(m.reason === 'kicked' ? '你已被房主移出房间' : '已退出房间');
      goHome();
      return;
    }
    if (m.type === 'closed') {
      notice('房间已解散');
      goHome();
      return;
    }
    if (m.type === 'ack') {
      finishAction(m.requestId, true);
      return;
    }
    if (m.type === 'error') {
      if (m.requestId) {
        finishAction(m.requestId, false, m.message);
      } else if (m.code === 'auth') {
        handleAuthFailure(new Error(m.message || '身份验证失败，请重新加入'));
      } else if (m.message) {
        notice(m.message);
      }
      return;
    }
  };

  sock.onclose = () => {
    if (ws === sock) ws = null;
    clearTimeout(connectWatch);
    wsState = 'closed';
    if (!token) return;
    startPolling();
    setBanner('已断线，正在重连 · 轮询同步中', true, false);
    scheduleReconnect();
  };

  sock.onerror = () => {
    try { sock.close(); } catch {}
  };
}

function startPolling() {
  if (pollTimer || !roomId || !token) return;
  pollTimer = setInterval(async () => {
    try {
      const r = await api('state', { room: roomId, token });
      applyState(r.state, r.serverNow);
    } catch (e) {
      if (e.code === 'auth') handleAuthFailure(e);
    }
  }, 850);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (Date.now() - wsLastMessage > 45000) {
      try { ws.close(); } catch {}
    } else {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
    }
  }
}, 20000);

/* ---------- 加入流程 ---------- */

async function joinRoom(mode, name) {
  try {
    let r;
    if (mode === 'join') {
      r = await api('join', { room: roomId, name, game: '50k' });
    } else {
      r = await api('create', { name, game: '50k' });
      roomId = r.room;
    }
    if (r.room) roomId = r.room;
    seat = r.seat;
    token = r.token;
    lastVersion = -1;
    lastLeadSig = null;
    lastPlaySigs = {};
    lastWindSeq = 0;
    windInitialized = false;
    lastResultSig = '';
    lastHandKey = '';
    selection.clear();
    saveSession();
    history.replaceState(null, '', '#room=' + roomId);
    showGame();
    applyState(r.state, r.state.serverNow);
    if (mode === 'demo') {
      try {
        for (let i = 0; i < 6; i++) {
          if (i === seat) continue;
          const b = await api('addbot', { room: roomId, token, seat: i });
          applyState(b.state, b.state.serverNow);
        }
        const started = await api('start', { room: roomId, token });
        applyState(started.state, started.state.serverNow);
      } catch (e) {
        notice(e.message);
      }
    }
    connectWS();
  } catch (e) {
    notice(e.message);
    if (mode === 'join') openJoin('join');
  }
}

/* ---------- 事件绑定 ---------- */

$('#demo').onclick = () => openJoin('demo');
$('#create').onclick = () => openJoin('create');
$('#joinRoomOpen').onclick = () => { roomId = ''; openJoin('join'); };
$('#copyInvite').onclick = () => copyInvite();
$('#cancelJoin').onclick = () => { $('#joinModal').style.display = 'none'; };
$('#roomCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^0-9A-F]/g, '').slice(0, 6);
});
$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const name = $('#nickname').value.trim() || '玩家';
  if (pending === 'join') {
    const code = ($('#roomCode').value || '').trim().toUpperCase().replace(/[^0-9A-F]/g, '');
    if (code.length !== 6) {
      notice('请输入 6 位房间码');
      $('#roomCode').focus();
      return;
    }
    roomId = code;
  }
  $('#joinModal').style.display = 'none';
  joinRoom(pending, name);
};

$('#nextGame').onclick = () => sendAction('next', {}, { clearSelection: true });
$('#trickCenter').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lobby]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.lobby;
  if (action === 'kick') {
    if (!confirm('确定踢出该玩家？')) return;
    sendAction('kick', { seat: Number(btn.dataset.seat) });
  } else if (action === 'leave') {
    if (!confirm('确定退出房间？')) return;
    sendAction('leave');
  } else if (action === 'dissolve') {
    if (!confirm('确定解散房间？')) return;
    sendAction('dissolve');
  } else if (action === 'ready') {
    sendAction('ready');
  } else if (action === 'start') {
    sendAction('start');
  } else if (action === 'copy') {
    copyInvite();
  } else if (action === 'addbot') {
    sendAction('addbot', { seat: Number(btn.dataset.seat) });
  } else if (action === 'removebot') {
    sendAction('removebot', { seat: Number(btn.dataset.seat) });
  } else if (action === 'sit') {
    sendAction('sit', { seat: Number(btn.dataset.seat) });
  } else if (action === 'bots') {
    sendAction('bots');
  }
});
$('#playCards').onclick = () => {
  ensureAudio();
  const cards = [...selection];
  if (!cards.length) return;
  hintBreaks = 0;
  sendAction('play', { cards }, { clearSelection: true });
};
$('#passTurn').onclick = () => {
  ensureAudio();
  hintBreaks = 0;
  sendAction('pass', {}, { clearSelection: true });
};
$('#hint').onclick = () => {
  if (!state || busy()) return;
  const key = `${state.version}:${state.turn}`;
  if (hintKey !== key) {
    hintKey = key;
    hintIndex = -1;
  }
  const hints = buildHints(state);
  if (!hints.length) {
    hintBreaks = 0;
    myNotice('没有能压过上家的牌，要不起');
    return;
  }
  const cur = [...selection].sort().join(',');
  const curIdx = hints.findIndex((h) => h.cards.map((c) => c.id).sort().join(',') === cur);
  if (curIdx >= 0) hintIndex = curIdx;
  hintIndex = (hintIndex + 1) % hints.length;
  const hint = hints[hintIndex];
  selection = new Set(hint.cards.map((c) => c.id));
  hintBreaks = hint.breaks;
  if (hint.breaks > 0) myNotice('提示需要拆牌才能压过上家');
  render(state);
};
$('#leaveGame').onclick = () => {
  if (!state) return;
  const msg = state.started ? '退出房间？剩下的牌会由机器人接管' : '退出房间？';
  if (!confirm(msg)) return;
  sendAction('leave');
};
$('#dissolveGame').onclick = () => {
  if (!state || seat !== state.hostSeat) return;
  if (!confirm('强制解散房间？所有玩家都会退出')) return;
  sendAction('dissolve');
};
$('#soundToggle').onclick = () => {
  muted = !muted;
  try { localStorage.setItem('dandong50k-muted', muted ? '1' : '0'); } catch {}
  updateSoundToggle();
  if (!muted) {
    ensureAudio();
    beep('turn');
  }
};

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#room=([0-9A-Fa-f]{6})$/);
  if (!m || document.body.classList.contains('in-game')) return;
  roomId = m[1].toUpperCase();
  openJoin('join');
});

function syncViewport() {
  document.documentElement.style.setProperty('--app-h', `${Math.round(window.innerHeight)}px`);
  requestAnimationFrame(() => fitHand());
}

function onViewportChange() {
  syncViewport();
  setTimeout(syncViewport, 120);
  setTimeout(syncViewport, 350);
  setTimeout(syncViewport, 700);
}

window.addEventListener('online', () => connectWS());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { connectWS(); syncViewport(); }
});
window.addEventListener('orientationchange', () => {
  onViewportChange();
});
window.addEventListener('resize', onViewportChange);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);

/* ---------- 启动 ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try { navigator.serviceWorker.register('../sw.js?v=20').catch(() => {}); } catch {}
  });
}

syncViewport();
bindHandPointer();
preloadCardFaces();

function bootFromSession() {
  const saved = loadSession();
  if (!saved) return false;
  roomId = saved.room;
  seat = saved.seat ?? -1;
  token = saved.token;
  history.replaceState(null, '', '#room=' + roomId);
  showGame();
  connectWS();
  return true;
}

muted = (() => { try { return localStorage.getItem('dandong50k-muted') === '1'; } catch { return false; } })();
updateSoundToggle();

if (location.hash.startsWith('#room=')) {
  roomId = location.hash.slice(6).toUpperCase();
  const saved = loadSession();
  if (saved && saved.room === roomId) {
    seat = saved.seat ?? -1;
    token = saved.token;
    showGame();
    connectWS();
  } else {
    token = '';
    openJoin('join');
  }
} else if (!bootFromSession()) {
  // 首页：等待创建或加入
}
