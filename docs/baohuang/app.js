'use strict';
/* 五人保皇前端：阶段 UI、皇帝登基、混儿出牌、给风与结算。 */

const $ = (s) => document.querySelector(s);
const SESSION_KEY = 'baohuang-session';
const RANK_SIX = 6;
const RANK_TWO = 15;
const RANK_SMALL = 16;
const RANK_BIG = 17;
const TOP_POWER = 1000;
const RANK_NAME = ['头科', '二科', '三科', '二落', '大落'];
const RANK_LABEL = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
const SUIT_LABEL = { 0: '♠', 1: '♥', 2: '♣', 3: '♦' };
const PHASE_LABEL = { lobby: '候场', dealing: '发牌中', buy6: '买6中', emperor: '皇帝确认', playing: '打牌中', wind: '给风中', settlement: '结算' };

let state = null;
let roomId = '';
let seat = -1;
let token = '';
let selection = new Set();
let pending = 'create';
let pendingAction = false;
let serverSkew = 0;
let lastVersion = -1;
let lastTurnKey = '';
let lastFinished = false;
let lastWindSeq = 0;
let windInitialized = false;
let lastHandKey = '';
let lastResultKey = '';
let hintIndex = -1;
let hintKey = '';
let warnedDeadline = null;
let lastPlaySigs = {};
let client = null;

const session = DD.session(SESSION_KEY);

function saveSession() {
  if (!roomId || !token) return;
  session.save({ room: roomId, seat, token });
}

function saveAndClear() {
  session.clear();
}

function describeError(e) {
  return e && e.message ? e.message : '操作失败';
}

async function api(action, data = {}) {
  return DD.api(action, { room: roomId, token, ...data });
}

/* ---------- 客户端规则（与服务端保持一致） ---------- */

function ctxOf(s) {
  return { emperorIds: new Set(s.emperorTripleIds || []), guardId: s.guardCardId || null };
}

function wildPower(rank) {
  return rank === RANK_TWO ? 1 : 2;
}

function typeOf(cards, cx) {
  const n = cards.length;
  if (!n) return null;
  const emperorIds = cx.emperorIds || new Set();
  const guardId = cx.guardId || null;
  const emperorCards = cards.filter((c) => emperorIds.has(c.id));
  const guardCard = cards.find((c) => c.id === guardId) || null;
  const sixes = cards.filter((c) => c.rank === RANK_SIX);
  if (sixes.length) {
    if (n !== 1) return null;
    return { kind: 'six', n: 1, power: 0 };
  }
  if (guardCard) {
    if (n !== 1) return null;
    return { kind: 'single', n: 1, power: TOP_POWER, role: 'guard' };
  }
  if (emperorCards.length && emperorCards.length !== n) return null;
  if (n === 1) {
    const c = cards[0];
    if (emperorCards.length) return { kind: 'single', n: 1, power: TOP_POWER, role: 'emperor', rank: c.rank };
    return { kind: 'single', n: 1, power: c.rank, rank: c.rank, wild: c.rank === RANK_TWO || c.rank >= 16 };
  }
  if (emperorCards.length) {
    if (n === 2) return { kind: 'emperorPair', n: 2, power: TOP_POWER };
    if (n === 3) return { kind: 'emperorBomb', n: 3, power: TOP_POWER, bombLevel: 6 };
    return null;
  }
  const ranks = cards.map((c) => c.rank);
  const suits = cards.map((c) => c.suit);
  if (ranks.every((r) => r >= RANK_SMALL) && ranks.every((r) => r === ranks[0]) && n >= 3) {
    const rank = ranks[0];
    const level = rank === RANK_SMALL ? (n === 3 ? 2 : n === 4 ? 4 : 0) : (n === 3 ? 3 : n === 4 ? 5 : 0);
    if (!level) return null;
    return { kind: 'jokerBomb', n, rank, power: rank, bombLevel: level };
  }
  if (n === 4 && suits.every((s) => s === suits[0]) && ranks.every((r) => r === ranks[0]) && ranks[0] >= 7 && ranks[0] <= RANK_TWO) {
    return { kind: 'suitBomb', n: 4, rank: ranks[0], power: ranks[0], bombLevel: 1 };
  }
  const normals = [];
  const wilds = [];
  for (const c of cards) {
    if (c.rank >= 7 && c.rank <= 14) normals.push(c.rank);
    else if (c.rank === RANK_TWO || c.rank >= RANK_SMALL) wilds.push(c.rank);
    else return null;
  }
  if (!normals.length) return null;
  if (!normals.every((r) => r === normals[0])) return null;
  if (wilds.some((r) => r === RANK_TWO) && wilds.some((r) => r >= RANK_SMALL)) return null;
  normals.sort((a, b) => b - a);
  const wp = wilds.map(wildPower).sort((a, b) => b - a);
  return { kind: 'combo', n, normals, wilds: wp, normalRank: normals[0], wildFamily: wp.length ? (wilds[0] === RANK_TWO ? 'two' : 'king') : null, power: normals[0] };
}

function isBombType(t) {
  return !!t && (t.kind === 'suitBomb' || t.kind === 'jokerBomb' || t.kind === 'emperorBomb');
}

function beatsType(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (b.kind === 'six' || a.kind === 'six') return false;
  const ab = isBombType(a);
  const bb = isBombType(b);
  if (ab && bb) {
    if (a.bombLevel !== b.bombLevel) return a.bombLevel > b.bombLevel;
    if (a.kind === 'suitBomb') return a.rank > b.rank;
    return false;
  }
  if (ab) return true;
  if (bb) return false;
  if (a.kind === 'single') return b.kind === 'single' && a.power > b.power;
  if (a.kind === 'emperorPair') return b.kind === 'combo' && b.n === 2;
  if (a.kind === 'combo') {
    if (b.kind !== 'combo' || a.n !== b.n) return false;
    const ln = Math.min(a.normals.length, b.normals.length);
    for (let i = 0; i < ln; i++) if (!(a.normals[i] > b.normals[i])) return false;
    const lw = Math.min(a.wilds.length, b.wilds.length);
    for (let i = 0; i < lw; i++) if (!(a.wilds[i] >= b.wilds[i])) return false;
    return true;
  }
  return false;
}

function describeType(t) {
  if (!t) return '不成牌型';
  switch (t.kind) {
    case 'six': return '6';
    case 'single':
      if (t.role === 'emperor') return '皇炸单张';
      if (t.role === 'guard') return '侍卫牌';
      return `${RANK_LABEL[t.rank]}单张`;
    case 'emperorPair': return '皇炸对子';
    case 'emperorBomb': return '皇炸三张';
    case 'suitBomb': return `${RANK_LABEL[t.rank]}同花炸弹`;
    case 'jokerBomb': return `${t.n}张${t.rank === RANK_SMALL ? '小王' : '大王'}炸弹`;
    case 'combo': {
      const base = `${RANK_LABEL[t.normalRank]}×${t.normals.length}`;
      if (!t.wilds.length) return base;
      return `${base} + 混儿${t.wildFamily === 'two' ? '2' : '王'}×${t.wilds.length}`;
    }
    default: return '不成牌型';
  }
}

function checkSelection(s) {
  if (!s) return { ok: false, error: '未选牌' };
  const hand = s.hand || [];
  const cards = hand.filter((c) => selection.has(c.id));
  if (!cards.length) return { ok: false, error: '未选牌' };
  const type = typeOf(cards, ctxOf(s));
  if (!type) return { ok: false, error: '当前牌型不合法', type: null, cards };
  if (cards.some((c) => c.rank === RANK_SIX) && (cards.length !== 1 || hand.length !== 1)) {
    return { ok: false, error: '当前不能打出6，6必须作为最后一张牌', type, cards };
  }
  if (s.guardCardId && cards.some((c) => c.id === s.guardCardId) && cards.length !== 1) {
    return { ok: false, error: '侍卫牌只能作为单张打出', type, cards };
  }
  const target = s.lead && s.lead.seat !== seat ? s.lead : null;
  return { ok: true, type, cards, beats: type.kind === 'six' ? true : beatsType(type, target) };
}

function findTriplesClient(hand) {
  const groups = new Map();
  for (const c of hand || []) {
    if (c.rank < 7 || c.rank > 15) continue;
    const key = `${c.suit}-${c.rank}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const cards of groups.values()) if (cards.length === 3) out.push(cards);
  out.sort((a, b) => b[0].rank - a[0].rank || a[0].suit - b[0].suit);
  return out;
}

function tripleIds(s) {
  return new Set(findTriplesClient(s.hand || []).flatMap((g) => g.map((c) => c.id)));
}

function selectedTripleOk(s) {
  if (selection.size !== 3) return false;
  const cards = (s.hand || []).filter((c) => selection.has(c.id));
  if (cards.length !== 3) return false;
  const groups = findTriplesClient(s.hand || []);
  const want = cards.map((c) => c.id).sort().join(',');
  return groups.some((g) => g.map((c) => c.id).sort().join(',') === want);
}

/* ---------- 提示 ---------- */

function buildHints(s) {
  const hand = s.hand || [];
  const cx = ctxOf(s);
  const target = s.lead && s.lead.seat !== seat ? s.lead : null;
  const out = [];
  const seen = new Set();
  const add = (cards) => {
    if (!cards || !cards.length) return;
    const key = cards.map((c) => c.id).sort().join(',');
    if (seen.has(key)) return;
    const type = typeOf(cards, cx);
    if (!type) return;
    if (cards.some((c) => c.rank === RANK_SIX) && (cards.length !== 1 || hand.length !== 1)) return;
    if (s.guardCardId && cards.some((c) => c.id === s.guardCardId) && cards.length !== 1) return;
    if (target && type.kind !== 'six' && !beatsType(type, target)) return;
    seen.add(key);
    out.push({ cards: cards.slice(), type, cost: hintCost(s, cards, type) });
  };
  for (const c of hand) add([c]);

  const byRank = new Map();
  for (const c of hand) {
    if (c.rank < 7 || c.rank > 14) continue;
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  for (const group of byRank.values()) for (let n = 2; n <= group.length; n++) add(group.slice(0, n));

  const emperor = hand.filter((c) => (s.emperorTripleIds || []).includes(c.id));
  for (let n = 2; n <= 3; n++) if (emperor.length >= n) add(emperor.slice(0, n));

  for (const rank of [RANK_SMALL, RANK_BIG]) {
    const group = hand.filter((c) => c.rank === rank);
    for (let n = 3; n <= group.length; n++) add(group.slice(0, n));
  }

  const suitGroups = new Map();
  for (const c of hand) {
    if (c.rank < 7 || c.rank > RANK_TWO) continue;
    const key = `${c.suit}-${c.rank}`;
    if (!suitGroups.has(key)) suitGroups.set(key, []);
    suitGroups.get(key).push(c);
  }
  for (const group of suitGroups.values()) if (group.length === 4) add(group);

  const twos = hand.filter((c) => c.rank === RANK_TWO && !(s.emperorTripleIds || []).includes(c.id));
  const kings = hand.filter((c) => c.rank >= RANK_SMALL);
  const nTarget = target ? target.n : 0;
  for (const group of byRank.values()) {
    const maxN = target ? Math.min(hand.length, nTarget) : Math.min(8, group.length + twos.length + kings.length);
    for (let n = 2; n <= maxN; n++) {
      for (let k = 1; k <= Math.min(group.length, n); k++) {
        const w = n - k;
        if (!w) continue;
        if (twos.length >= w) add([...group.slice(0, k), ...twos.slice(0, w)]);
        if (kings.length >= w) add([...group.slice(0, k), ...kings.slice(0, w)]);
      }
    }
  }

  out.sort((a, b) => a.cost - b.cost || a.type.n - b.type.n || (a.type.power || 0) - (b.type.power || 0));
  return out;
}

function hintCost(s, cards, type) {
  let cost = 0;
  if (type.kind === 'six') cost += 100;
  if (s.guardCardId && cards.some((c) => c.id === s.guardCardId)) cost += 30;
  if (cards.some((c) => (s.emperorTripleIds || []).includes(c.id))) cost += 30;
  const wild = cards.filter((c) => c.rank === RANK_TWO || c.rank >= RANK_SMALL).length;
  cost += wild * 8;
  const total = new Map();
  for (const c of s.hand || []) total.set(c.rank, (total.get(c.rank) || 0) + 1);
  const used = new Map();
  for (const c of cards) used.set(c.rank, (used.get(c.rank) || 0) + 1);
  for (const [r, u] of used) if ((total.get(r) || 0) > 1 && u < total.get(r)) cost += 2;
  if (cards.length > 1) cost += 0.5;
  cost += (type.power || 0) / 1000;
  return cost;
}

/* ---------- 界面状态 ---------- */

function setBanner(text, warn) {
  const b = $('#connBanner');
  if (!b) return;
  b.textContent = text || '';
  b.classList.toggle('warn', !!warn);
  b.classList.toggle('show', !!text);
}

function showGame() {
  document.body.classList.add('in-game');
  $('#online').style.display = 'flex';
  $('#roomLabel').textContent = '房间码 ' + roomId;
  lockLandscape();
}

function lockLandscape() {
  try { screen.orientation?.lock?.('landscape').catch(() => {}); } catch {}
}

function shareBase() {
  if (/(^|\.)railway\.app$/.test(location.hostname)) {
    return 'https://gogogo123-cmd.github.io/dandong-50k/baohuang/';
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
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    DD.notice(`邀请链接已复制 · 房间码 ${roomId}`);
  } catch {
    DD.notice(`复制失败，请手动分享房间码 ${roomId}`);
  }
}

function applyState(s, serverNow) {
  if (!s) return;
  if (typeof s.version === 'number' && lastVersion >= 0 && s.version < lastVersion) return;
  if (s.closed) {
    DD.notice('房间已解散');
    goHome();
    return;
  }
  if (Number.isInteger(s.yourSeat) && s.yourSeat >= 0) seat = s.yourSeat;
  if (seat >= 0 && Array.isArray(s.players) && s.players[seat] == null) {
    DD.notice('你已离开或被移出房间');
    goHome();
    return;
  }
  if (typeof s.serverNow === 'number') serverSkew = s.serverNow - Date.now();
  else if (typeof serverNow === 'number') serverSkew = serverNow - Date.now();
  if (typeof s.version === 'number') lastVersion = s.version;

  if (s.hand) for (const id of [...selection]) if (!s.hand.some((c) => c.id === id)) selection.delete(id);

  const turnKey = `${s.phase}:${s.actorSeat}:${s.turnDeadline}`;
  if (turnKey !== lastTurnKey) {
    lastTurnKey = turnKey;
    hintIndex = -1;
    hintKey = '';
    if (s.started && !s.finished && s.actorSeat === seat) DD.audio.beep('turn');
  }
  if (s.finished && !lastFinished) DD.audio.beep('end');
  lastFinished = !!s.finished;

  state = s;
  render(s);
  updateCountdown();
  checkWind(s);
}

function goHome() {
  if (client) client.close();
  client = null;
  pendingAction = false;
  roomId = '';
  seat = -1;
  token = '';
  selection.clear();
  state = null;
  lastVersion = -1;
  lastTurnKey = '';
  lastFinished = false;
  lastWindSeq = 0;
  windInitialized = false;
  lastHandKey = '';
  lastResultKey = '';
  saveAndClear();
  document.body.classList.remove('in-game');
  document.body.classList.remove('lobby-mode');
  const online = $('#online');
  if (online) online.style.display = 'none';
  const modal = $('#joinModal');
  if (modal) modal.style.display = 'none';
  const round = $('#roundModal');
  if (round) round.classList.remove('show');
  const wind = $('#windModal');
  if (wind) wind.classList.remove('show');
  const buy6 = $('#buy6Modal');
  if (buy6) buy6.classList.remove('show');
  history.replaceState(null, '', location.pathname + location.search);
  setBanner('', false);
}

function render(s) {
  state = s;
  document.body.classList.toggle('lobby-mode', !s.started);
  const phase = s.phase || (s.started ? 'playing' : 'lobby');
  const label = $('#phaseLabel');
  label.textContent = PHASE_LABEL[phase] || '牌局';
  label.className = `phase-label${phase === 'wind' ? ' wind' : phase === 'settlement' ? ' settle' : ''}`;
  $('#roomLabel').textContent = '房间码 ' + roomId;

  const leaveBtn = $('#leaveGame');
  if (leaveBtn) leaveBtn.style.display = (s.started || (s.players || []).some((p) => p && p.bot)) ? 'inline-block' : 'none';
  const dissolveBtn = $('#dissolveGame');
  if (dissolveBtn) dissolveBtn.style.display = s.started && seat === s.hostSeat ? 'inline-block' : 'none';

  renderCenter(s);
  renderEmperorBomb(s);
  renderPlayers(s);
  renderMyPlay(s);
  renderMySeat(s);
  renderHand(s);
  updateActionBar(s);
  renderBuy6Modal(s);
  renderWindModal(s);
  renderRoundModal(s);
  $('#gameLog').textContent = (s.log || []).slice(-3).join('　·　');
}

function renderCenter(s) {
  const box = $('#trickCenter');
  if (!s.started) {
    renderLobby(s);
    return;
  }
  // 只有需要玩家操作的阶段才显示中间面板；打牌/结算阶段隐藏，避免遮挡出牌区。
  if (s.phase !== 'buy6' && s.phase !== 'emperor' && s.phase !== 'wind') {
    box.innerHTML = '';
    return;
  }
  if (s.phase === 'buy6') {
    const buyer = s.players?.[s.buy6Seat];
    const isMe = s.buy6Seat === seat;
    const sellers = (s.buy6Sellers || []).map(({ seat: i, extra }) => `${DD.esc(s.players?.[i]?.name || `${i + 1}号位`)}（多${extra}张）`).join('、');
    box.innerHTML = `<div class="center-box">
      <div class="center-title">买6中</div>
      <div class="center-sub">${isMe ? '轮到你买6，请选择出售多余6的玩家。' : `等待 <b>${DD.esc(buyer?.name || '')}</b> 买6。`}</div>
      <div class="center-sub">持有额外6：${sellers || '无'}</div>
      <div class="center-sub">支付优先使用 2 → 小王 → 大王。</div>
    </div>`;
    return;
  }
  if (s.phase === 'emperor') {
    const cand = s.players?.[s.candidateSeat];
    const isMe = s.candidateSeat === seat;
    const triples = findTriplesClient(s.hand || []);
    box.innerHTML = `<div class="center-box">
      <div class="center-title">皇帝与侍卫确认</div>
      <div class="center-sub">候选人：<b>${DD.esc(cand?.name || '')}</b>${s.transferCount ? ` · 已让位 ${s.transferCount} 次` : ''}</div>
      <div class="center-sub">${isMe
        ? (triples.length
          ? `你有 ${triples.length} 组合法三张，请选择三张同花色同点数牌后点击“登基”。`
          : '你没有满足条件的三张牌，只能让位给上家。')
        : '等待候选人确认三张同花色同点数的牌。'}</div>
    </div>`;
    return;
  }
  if (s.phase === 'wind') {
    const giver = s.players?.[s.windGiverSeat]?.name || '';
    box.innerHTML = `<div class="center-box">
      <div class="center-title">给风中</div>
      <div class="center-sub"><b>${DD.esc(giver)}</b> 已出完最后一张6，正在选择接风者。</div>
      <div class="center-sub">接风者将直接领出，无需压制上一手牌。</div>
    </div>`;
  }
}

function renderEmperorBomb(s) {
  const el = $('#emperorBomb');
  if (!el) return;
  const cards = s.started && !s.finished ? (s.emperorTripleCards || []) : [];
  if (!cards.length) {
    el.style.display = 'none';
    el.innerHTML = '';
    return;
  }
  el.style.display = 'flex';
  el.innerHTML = `<span class="eb-label">皇炸</span>${cards.map((c) => cardHTMLForState(s, c)).join('')}`;
}

function paidLabel(card) {
  if (!card) return '?';
  if (card.rank >= 16) return RANK_LABEL[card.rank];
  if (card.rank === RANK_SIX) return '6';
  return `${SUIT_LABEL[card.suit] || ''}${RANK_LABEL[card.rank]}`;
}

function renderLobby(s) {
  const players = s.players || [];
  const occupied = players.filter(Boolean).length;
  const ready = players.filter((p) => p && p.ready).length;
  const isHost = seat === s.hostSeat;
  const me = players[seat];
  const rows = players.map((p, i) => {
    if (!p) {
      const btns = [];
      if (isHost) btns.push(`<button class="mini-btn" data-lobby="addbot" data-seat="${i}" type="button">+机器人</button>`);
      btns.push(`<button class="mini-btn" data-lobby="sit" data-seat="${i}" type="button">坐这里</button>`);
      return `<div class="lobby-row empty"><span class="lobby-seat">${i + 1}号位</span><span class="lobby-name">空位</span><span class="lobby-state">${btns.join('')}</span></div>`;
    }
    const tags = [i === seat ? '你' : '', i === s.hostSeat ? '房主' : '', p.bot ? '机器人' : ''].filter(Boolean).join(' · ');
    const stateText = p.ready ? '<b class="ok">已准备</b>' : '<b class="no">未准备</b>';
    let manage = '';
    if (isHost && i !== seat) {
      if (p.bot) manage = `<button class="mini-btn" data-lobby="removebot" data-seat="${i}" type="button">移除</button>`;
      else if (!p.ready) manage = `<button class="mini-btn" data-lobby="kick" data-seat="${i}" type="button">踢出</button>`;
    }
    return `<div class="lobby-row ${i === seat ? 'mine' : ''}"><span class="lobby-seat">${i + 1}号位</span><span class="lobby-name">${DD.esc(p.name)}${tags ? `<i>${tags}</i>` : ''}</span><span class="lobby-state">${stateText}${manage}</span></div>`;
  }).join('');
  const actions = isHost
    ? `<button class="btn primary" data-lobby="start" type="button" ${s.canStart ? '' : 'disabled'}>开始游戏</button><button class="btn" data-lobby="dissolve" type="button">解散房间</button>`
    : `<button class="btn primary" data-lobby="ready" type="button">${me?.ready ? '取消准备' : '准备'}</button><button class="btn" data-lobby="leave" type="button">退出房间</button>`;
  const hint = isHost
    ? (s.canStart ? '五人已准备，可以开始' : '空位可逐个加机器人或换座；5 人准备后开始')
    : (me?.ready ? '已准备，等待房主开始' : '准备后等待房主开始');
  $('#trickCenter').innerHTML = `<div class="lobby-panel">
    <div class="lobby-title">候场大厅</div>
    <div class="lobby-count">入座 ${occupied}/5 · 已准备 ${ready}/5</div>
    <div class="lobby-code" data-lobby="copy" role="button" title="点击复制邀请链接">房间码 <b>${DD.esc(s.id)}</b> · 点击复制邀请链接</div>
    <div class="lobby-list">${rows}</div>
    <div class="lobby-actions">${actions}</div>
    <div class="lobby-hint">${hint}</div>
  </div>`;
}

function roleBadge(s, i) {
  const p = s.players?.[i];
  if (!p) return '';
  if (p.emperor) return '<span class="role-badge">皇帝</span>';
  if (p.guard) return '<span class="role-badge guard">侍卫</span>';
  if (p.candidate && s.phase === 'emperor') return '<span class="role-badge candidate">候选</span>';
  return '';
}

function cardHTMLForState(s, c, opts = {}) {
  const emperor = (s.emperorTripleIds || []).includes(c.id);
  const guard = !!s.guardCardId && c.id === s.guardCardId;
  const special = !!s.specialJokerId && c.id === s.specialJokerId;
  const extra = opts.extraClass || '';
  let role = '';
  let badge = '';
  if (emperor) { role = 'emperor'; badge = '皇'; }
  else if (guard) { role = 'guard'; badge = '侍'; }
  else if (c.rank === RANK_SIX) { role = 'six'; }
  else if (c.rank === RANK_TWO || c.rank >= RANK_SMALL) { role = 'wild'; }
  role = `${role} ${extra}`.trim();
  if (special) role = `${role} special`.trim();
  const { extraClass, ...rest } = opts;
  void extraClass;
  return DD.cardHTML(c, { ...rest, role, badge });
}

function playedCardsHTML(s, cards, opts = {}) {
  const t = typeOf(cards || [], ctxOf(s));
  const bomb = isBombType(t) && t.kind !== 'emperorBomb';
  return (cards || []).map((c) => cardHTMLForState(s, c, { ...opts, extraClass: bomb ? 'bomb-card' : undefined })).join('');
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

function renderPlayers(s) {
  const prevSigs = lastPlaySigs || {};
  const nextSigs = {};
  const html = (s.players || []).map((p, i) => {
    if (!p || i === seat) return '';
    const rel = (i - seat + 5) % 5;
    const active = s.actorSeat === i;
    const roleCls = p.emperor ? 'team-emperor' : (p.guard ? 'team-guard' : '');
    const avatar = `${p.bot ? '机' : DD.esc((p.name || '玩家').slice(0, 1))}${s.started && !p.done ? cardStackHTML(p.count) : ''}`;
    const psig = p.lastPlay && p.lastPlay.length ? p.lastPlay.map((c) => c.id).join(',') : '';
    nextSigs[i] = psig;
    const animate = psig && psig !== prevSigs[i];
    const online = p.bot ? '' : `<span class="online-dot ${p.online ? '' : 'off'}"></span>`;
    const rankTag = p.rank ? `<i class="seat-rank">${RANK_NAME[p.rank - 1]}</i>` : '';
    const roleTag = p.emperor ? '皇帝' : p.guard ? '侍卫' : (s.guardPublic ? '革命党' : '身份未知');
    const roleClsAttr = p.emperor || p.guard || s.guardPublic ? '' : ' class="role-unknown"';
    const meta = `${online}${p.count}张 · <span${roleClsAttr}>${roleTag}</span>${rankTag}`;
    let play = '';
    if (s.started && !s.finished) {
      const timer = active ? '<span class="seat-timer go show play-timer">--</span>' : '';
      const holdingLast = p.done && s.phase === 'wind' && p.lastPlay?.length;
      if (p.lastPlay?.length && (!p.done || holdingLast)) {
        const bomb = isBombType(typeOf(p.lastPlay, ctxOf(s)));
        play = `<div class="player-play ${bomb ? 'bomb-play' : ''}">${timer}${playedCardsHTML(s, p.lastPlay, { animate })}</div>`;
      } else if (p.done) {
        play = `<div class="player-play play-done"><span class="pass-pill done-pill">${p.rank ? RANK_NAME[p.rank - 1] : '已出完'}</span></div>`;
      } else if (s.passed?.[i]) {
        play = `<div class="player-play play-pass">${timer}<span class="pass-pill">不要</span></div>`;
      } else if (active) {
        play = `<div class="player-play play-turn">${timer}</div>`;
      }
    }
    return `<div class="player-seat bspot-${rel - 1} ${active ? 'active is-actor' : ''} ${roleCls} ${p.done ? 'done-seat' : ''}" data-seat="${i}">
      <div class="seat-head"><div class="avatar">${avatar}${roleBadge(s, i)}</div><span class="seat-name">${DD.esc(p.name)}${i === s.hostSeat ? '<span class="host-tag">房主</span>' : ''}</span></div>
      <div class="seat-meta">${meta}</div>${play}
    </div>`;
  }).join('');
  $('#players').innerHTML = html;
  lastPlaySigs = nextSigs;
}

function renderMyPlay(s) {
  const el = $('#myPlay');
  const me = s.players?.[seat];
  const mine = me?.lastPlay;
  const myPass = s.passed?.[seat];
  const show = s.started && !s.finished && s.actorSeat !== seat && (me?.done || myPass || (mine && mine.length));
  if (!show) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'flex';
  el.className = 'my-play';
  const holdingLast = me.done && s.phase === 'wind' && mine?.length;
  if (mine?.length && (!me.done || holdingLast)) {
    el.innerHTML = playedCardsHTML(s, mine);
  } else if (me.done) {
    el.innerHTML = `<span class="pass-pill done-pill">${me.rank ? RANK_NAME[me.rank - 1] : '已出完'}</span>`;
  } else if (myPass) {
    el.innerHTML = '<span class="pass-pill">不要</span>';
  } else {
    el.innerHTML = '';
  }
}

function renderMySeat(s) {
  const el = $('#mySeat');
  if (!el) return;
  const me = s.players?.[seat];
  const show = s.started && !s.finished && me;
  el.style.display = show ? 'flex' : 'none';
  if (!show) { el.innerHTML = ''; return; }
  const role = me.emperor ? 'emperor' : (s.yourRole === 'guard' ? 'guard' : 'revolution');
  el.className = `my-seat ${role === 'emperor' ? 'team-red' : 'team-blue'}${s.actorSeat === seat ? ' active' : ''}${me.done ? ' done' : ''}`;
  const badge = role === 'emperor' ? '<span class="role-badge">皇帝</span>' : role === 'guard' ? '<span class="role-badge guard">侍卫</span>' : '';
  el.innerHTML = `<div class="avatar">${me.bot ? '机' : DD.esc((me.name || '我').slice(0, 1))}${badge}</div>`;
  el.title = `${me.name || '我'} · ${role === 'emperor' ? '皇帝' : role === 'guard' ? '侍卫' : '革命党'}`;
}

// 手牌排序：普通牌 → 炸弹（从小到大）→ 皇炸 → 侍卫牌，后三者固定在最右端。
function bombPowers(hand, s) {
  const powers = new Map();
  const emperorSet = new Set(s?.emperorTripleIds || []);
  for (const c of hand) if (emperorSet.has(c.id)) powers.set(c.id, 900 + c.rank);
  const small = hand.filter((c) => c.rank === RANK_SMALL);
  const big = hand.filter((c) => c.rank === RANK_BIG);
  if (small.length >= 3) for (const c of small) powers.set(c.id, small.length >= 4 ? 400 : 200);
  if (big.length >= 3) for (const c of big) powers.set(c.id, big.length >= 4 ? 500 : 300);
  const groups = new Map();
  for (const c of hand) {
    if (c.rank === RANK_SIX || c.rank >= RANK_SMALL) continue;
    const key = `${c.suit}-${c.rank}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const arr of groups.values()) {
    if (arr.length >= 4 && !arr.some((c) => emperorSet.has(c.id))) {
      for (const c of arr) powers.set(c.id, 100 + c.rank);
    }
  }
  return powers;
}

function sortHand(hand, s) {
  const powers = bombPowers(hand, s);
  const guardId = s?.guardCardId || null;
  const rankOf = (c) => (c.rank === RANK_SIX ? 99 : c.rank);
  return [...(hand || [])].sort((a, b) => {
    const ga = a.id === guardId ? 1 : 0;
    const gb = b.id === guardId ? 1 : 0;
    if (ga !== gb) return ga - gb;
    const pa = powers.get(a.id);
    const pb = powers.get(b.id);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return -1;
      if (pb === undefined) return 1;
      if (pa !== pb) return pa - pb;
    }
    return rankOf(a) - rankOf(b) || a.suit - b.suit || a.id.localeCompare(b.id);
  });
}

function renderHand(s) {
  const hand = sortHand(s.hand || [], s);
  const isCandidate = s.phase === 'emperor' && s.candidateSeat === seat;
  const triples = isCandidate ? tripleIds(s) : new Set();
  const sig = `${hand.map((c) => c.id).join(',')}|${[...selection].sort().join(',')}|${s.emperorTripleIds?.join(',')}|${s.guardCardId || ''}|${isCandidate ? [...triples].sort().join(',') : ''}`;
  if (sig === lastHandKey) { fitHand(); return; }
  lastHandKey = sig;
  const row = $('#myHand');
  row.innerHTML = hand.map((c) => {
    const opts = { selected: selection.has(c.id) };
    if (triples.has(c.id)) opts.extraClass = 'triple-candidate';
    return cardHTMLForState(s, c, opts);
  }).join('');
  fitHand();
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
  const cardW = cards[0].getBoundingClientRect().width || parseFloat(getComputedStyle(cards[0]).width) || 0;
  if (!avail || !cardW) return;
  const maxStep = cardW - 12;
  const fitStep = (avail - cardW) / (cards.length - 1);
  const step = Math.max(4, Math.min(maxStep, fitStep));
  for (let i = 1; i < cards.length; i++) cards[i].style.marginLeft = `${step - cardW}px`;
}

function updateActionBar(s) {
  const bar = $('#actionBar');
  if (!s.started || s.finished) {
    bar.style.display = 'none';
    bar.classList.remove('turn-on');
    return;
  }
  bar.style.display = '';
  const isActor = s.actorSeat === seat;
  bar.classList.toggle('turn-on', isActor);
  const playBtn = $('#playCards');
  const passBtn = $('#passTurn');
  const hintBtn = $('#hint');
  playBtn.textContent = s.phase === 'emperor' ? '登基' : '出牌';
  passBtn.textContent = s.phase === 'emperor' ? '让位' : '不出';

  if (s.phase === 'emperor') {
    const candidate = s.candidateSeat === seat;
    const triples = candidate ? findTriplesClient(s.hand || []) : [];
    const ok = candidate && selectedTripleOk(s);
    playBtn.disabled = pendingAction || !candidate || !ok;
    passBtn.disabled = pendingAction || !candidate || triples.length > 0;
    hintBtn.disabled = pendingAction || !candidate;
    $('#actionHint').textContent = !candidate ? '等待候选人确认皇帝'
      : triples.length ? (ok ? '已选三张，可以登基' : '请选择三张同花色同点数牌')
        : '没有合法三张，请让位给上家';
    return;
  }
  if (s.phase === 'buy6') {
    playBtn.disabled = true;
    passBtn.disabled = true;
    hintBtn.disabled = true;
    $('#actionHint').textContent = s.buy6Seat === seat
      ? '请在弹窗中选择卖方'
      : `等待${s.players?.[s.buy6Seat]?.name || '玩家'}买6`;
    return;
  }
  if (s.phase === 'wind') {
    playBtn.disabled = true;
    passBtn.disabled = true;
    hintBtn.disabled = true;
    $('#actionHint').textContent = s.windGiverSeat === seat ? '请选择给风对象' : '等待给风';
    return;
  }
  if (s.phase !== 'playing') {
    playBtn.disabled = true;
    passBtn.disabled = true;
    hintBtn.disabled = true;
    $('#actionHint').textContent = '等待阶段推进';
    return;
  }
  const myTurn = s.actorSeat === seat;
  const chosen = (s.hand || []).filter((c) => selection.has(c.id));
  const check = checkSelection(s);
  const canPlay = !!(myTurn && check.type && check.beats);
  const target = s.lead && s.lead.seat !== seat ? s.lead : null;
  playBtn.disabled = pendingAction || !canPlay;
  passBtn.disabled = pendingAction || !myTurn || !target;
  hintBtn.disabled = pendingAction || !myTurn;
  const hintText = !myTurn ? '等待其他玩家'
    : chosen.length ? `已选：${describeType(check.type)}${canPlay ? ' · 可以出牌' : check.type ? ' · 压不过上家' : ' · 牌型不成立'}`
      : target ? '选牌压上家，或不要' : '选一手合法牌型';
  $('#actionHint').textContent = hintText;
}

function renderBuy6Modal(s) {
  const modal = $('#buy6Modal');
  const open = s.started && !s.finished && s.phase === 'buy6' && s.buy6Seat === seat;
  modal.classList.toggle('show', open);
  if (!open) return;
  const pay = (s.hand || []).find((c) => c.id === s.buy6PaymentId);
  $('#buy6Pay').innerHTML = pay
    ? `将支付 <span class="pay-card">${DD.cardHTML(pay)}</span>`
    : '你没有可支付的 2 或王，本局将重新发牌';
  $('#buy6List').innerHTML = (s.buy6Sellers || []).map(({ seat: i, extra }) => {
    const p = s.players?.[i];
    if (!p) return '';
    return `<button type="button" data-buy6seller="${i}">${DD.esc(p.name)}<small>多 ${extra} 张6</small></button>`;
  }).join('');
}

function renderWindModal(s) {
  const modal = $('#windModal');
  const list = $('#windList');
  const open = s.started && !s.finished && s.phase === 'wind' && s.windGiverSeat === seat;
  modal.classList.toggle('show', open);
  if (!open) { list.innerHTML = ''; return; }
  const options = s.windOptions || [];
  list.innerHTML = options.map((i) => {
    const p = s.players?.[i];
    if (!p) return '';
    const isGuard = !!s.guardPublic && i === s.guardSeat;
    const tag = p.emperor ? '皇帝' : isGuard ? '侍卫' : p.rank ? RANK_NAME[p.rank - 1] : '';
    return `<button type="button" class="${isGuard ? 'guard-target' : ''}" data-wind="${i}">${DD.esc(p.name)}${tag ? `<small>${tag}</small>` : ''}<small>${p.count} 张</small></button>`;
  }).join('');
}

function renderRoundModal(s) {
  const modal = $('#roundModal');
  modal.classList.toggle('show', !!s.finished);
  if (!s.finished) { lastResultKey = ''; return; }
  const emperorWin = s.winnerCamp === 'emperor';
  const result = $('#roundResult');
  result.className = `round-result ${emperorWin ? 'red' : 'blue'}`;
  result.innerHTML = `<b>${emperorWin ? '皇帝阵营获胜' : '革命党获胜'}</b><span>第 ${(s.gamesPlayed || 1)} 局</span>`;
  const emperor = s.players?.[s.emperorSeat];
  const guard = s.players?.[s.guardSeat];
  $('#identityLine').innerHTML = `皇帝：<b>${DD.esc(emperor?.name || '—')}</b> · 侍卫：<span class="guard">${DD.esc(guard?.name || '—')}</span>`;
  const rows = [];
  for (let i = 0; i < (s.rankings || []).length; i++) {
    const p = s.players?.[s.rankings[i]];
    if (!p) continue;
    const role = s.rankings[i] === s.emperorSeat ? '皇帝' : s.rankings[i] === s.guardSeat ? '侍卫' : '革命党';
    rows.push(`<div class="row"><b>${RANK_NAME[i]}</b><span>${DD.esc(p.name)} <span class="tag">${role}</span></span><span>已出完</span></div>`);
  }
  (s.players || []).forEach((p, i) => {
    if (!p || p.done) return;
    const role = i === s.emperorSeat ? '皇帝' : i === s.guardSeat ? '侍卫' : '革命党';
    rows.push(`<div class="row"><b>未出完</b><span>${DD.esc(p.name)} <span class="tag">${role}</span></span><span>${p.count} 张</span></div>`);
  });
  $('#resultRank').innerHTML = rows.join('');

  const remaining = (s.players || []).map((p, i) => ({ p, i })).filter(({ p }) => p && Array.isArray(p.remaining) && p.remaining.length);
  $('#roundHands').innerHTML = remaining.length
    ? `<div class="reveal-title">未出完手牌</div>` + remaining.map(({ p, i }) => {
      const hand = sortHand(p.remaining, s);
      return `<div class="reveal-row"><div class="reveal-name">${i === seat ? '你' : DD.esc(p.name)}<small>剩 ${hand.length} 张</small></div><div class="reveal-cards">${hand.map((c) => cardHTMLForState(s, c)).join('')}</div></div>`;
    }).join('')
    : '<div class="reveal-none">所有玩家均已出完</div>';

  const nextBtn = $('#nextGame');
  const isHost = seat === s.hostSeat;
  nextBtn.style.display = 'inline-block';
  nextBtn.disabled = pendingAction || !isHost;
  nextBtn.textContent = isHost ? '再来一局' : '等待房主开始下一局';

  const key = `${s.gamesPlayed}:${s.winnerCamp}:${(s.rankings || []).join(',')}`;
  if (key !== lastResultKey) {
    lastResultKey = key;
    spawnConfetti(emperorWin ? 'emperor' : 'revolution');
  }
}

function spawnConfetti(kind) {
  const box = $('#roundConfetti');
  if (!box) return;
  box.innerHTML = '';
  const colors = kind === 'emperor'
    ? ['#ffd166', '#e9c47a', '#ff6b61', '#ffe9d6']
    : ['#6eaed7', '#9fd9df', '#ffd166', '#dff2ff'];
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('i');
    piece.style.cssText = `left:${(Math.random() * 100).toFixed(1)}%;background:${colors[i % colors.length]};`
      + `--dx:${(Math.random() * 160 - 80).toFixed(0)}px;animation-delay:${(Math.random() * 0.7).toFixed(2)}s;`
      + `animation-duration:${(1.4 + Math.random() * 1.1).toFixed(2)}s;`
      + `width:${(5 + Math.random() * 5).toFixed(0)}px;height:${(9 + Math.random() * 8).toFixed(0)}px`;
    box.appendChild(piece);
  }
  clearTimeout(spawnConfetti.timer);
  spawnConfetti.timer = setTimeout(() => { box.innerHTML = ''; }, 3200);
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
  const mine = show && state.actorSeat === seat;
  const myTimer = $('#myTimer');
  myTimer.classList.toggle('show', mine);
  myTimer.classList.toggle('low', mine && low);
  if (mine) myTimer.textContent = `${sec}s`;
  myTimer.title = mine
    ? (state.phase === 'buy6' ? '超时自动买6' : state.phase === 'emperor' ? '超时自动登基或让位' : state.phase === 'wind' ? '超时自动给风' : state.lead && state.lead.seat !== seat ? '超时自动不要' : '超时自动出最小牌')
    : '你的操作倒计时';
  document.querySelectorAll('#players .seat-timer').forEach((el) => {
    el.textContent = show ? `${sec}s` : '';
    el.classList.toggle('low', low);
  });
  if (mine && rem !== null && rem <= 10 && state.turnDeadline !== warnedDeadline) {
    warnedDeadline = state.turnDeadline;
    DD.audio.beep('warn');
  }
}
setInterval(updateCountdown, 250);

function checkWind(s) {
  const wind = s.lastWind;
  if (!windInitialized) {
    windInitialized = true;
    lastWindSeq = wind && Number.isInteger(wind.seq) ? wind.seq : 0;
    return;
  }
  if (!wind || !Number.isInteger(wind.seq) || wind.seq === lastWindSeq) return;
  lastWindSeq = wind.seq;
  const giver = s.players?.[wind.giver]?.name || '玩家';
  const taker = wind.seat === seat ? '你' : (s.players?.[wind.seat]?.name || '玩家');
  const el = $('#windBanner');
  if (el) {
    el.textContent = `给风 · ${giver} → ${taker}`;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(checkWind.timer);
    checkWind.timer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  const seatEl = wind.seat === seat ? $('#mySeat') : document.querySelector(`#players .player-seat[data-seat="${wind.seat}"]`);
  if (seatEl) {
    seatEl.classList.add('wind-hit');
    setTimeout(() => seatEl.classList.remove('wind-hit'), 1800);
  }
}

/* ---------- 操作 ---------- */

async function doAction(action, extra = {}, opts = {}) {
  if (pendingAction) return;
  pendingAction = true;
  render(state);
  try {
    const r = await api(action, extra);
    if (r.state) applyState(r.state, r.serverNow);
    if (opts.clearSelection) selection.clear();
    if (opts.notice) DD.notice(opts.notice);
  } catch (e) {
    DD.notice(describeError(e));
    if (e.code === 'auth') handleAuthFailure(e);
  } finally {
    pendingAction = false;
    if (state) render(state);
  }
}

function playSelected() {
  if (!state) return;
  DD.audio.ensure();
  if (state.phase === 'emperor') {
    if (!selectedTripleOk(state)) return DD.notice('请选择三张同花色同点数的牌');
    return doAction('emperor', { cards: [...selection] }, { clearSelection: true });
  }
  const check = checkSelection(state);
  if (!check.ok) return DD.notice(check.error);
  if (!check.beats) return DD.notice('这手牌压不过上家');
  doAction('play', { cards: [...selection] }, { clearSelection: true });
}

function passTurn() {
  if (!state) return;
  DD.audio.ensure();
  if (state.phase === 'emperor') {
    if (findTriplesClient(state.hand || []).length) return DD.notice('你已满足登基条件，必须登基');
    return doAction('emperor', { yield: true });
  }
  doAction('pass');
}

function useHint() {
  if (!state) return;
  if (state.phase === 'emperor') {
    const triples = findTriplesClient(state.hand || []);
    if (!triples.length) return DD.notice('没有合法三张，只能让位');
    selection = new Set(triples[0].map((c) => c.id));
    return render(state);
  }
  if (state.phase !== 'playing') return;
  const key = `${state.version}:${state.actorSeat}`;
  if (hintKey !== key) { hintKey = key; hintIndex = -1; }
  const hints = buildHints(state);
  if (!hints.length) return DD.myNotice('没有能压过上家的牌，要不起');
  const cur = [...selection].sort().join(',');
  const curIdx = hints.findIndex((h) => h.cards.map((c) => c.id).sort().join(',') === cur);
  if (curIdx >= 0) hintIndex = curIdx;
  hintIndex = (hintIndex + 1) % hints.length;
  selection = new Set(hints[hintIndex].cards.map((c) => c.id));
  render(state);
}

/* ---------- 手牌选择 ---------- */

function bindHandPointer() {
  const handEl = $('#myHand');
  if (!handEl) return;
  let dragging = false;
  let moved = false;
  let mode = false;
  let startCard = null;
  let lastId = '';
  let startX = 0;
  let startY = 0;
  const canSelect = () => state && state.started && !state.finished
    && (state.phase === 'playing' || state.phase === 'emperor')
    && state.actorSeat === seat && !pendingAction;
  const apply = (id, on) => {
    if (on) selection.add(id); else selection.delete(id);
    for (const el of handEl.querySelectorAll('.card')) if (el.dataset.id === id) el.classList.toggle('selected', on);
  };
  handEl.addEventListener('pointerdown', (e) => {
    if (!canSelect()) return;
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
      if (selection.has(id)) selection.delete(id); else selection.add(id);
    }
    startCard = null;
    if (state) render(state);
  };
  handEl.addEventListener('pointerup', finish);
  handEl.addEventListener('pointercancel', finish);
}

/* ---------- 连接 ---------- */

function handleAuthFailure(e) {
  if (!roomId) return;
  token = '';
  saveAndClear();
  if (client) { client.close(); client = null; }
  setBanner('身份已失效，请重新加入', true);
  DD.notice(describeError(e) || '身份验证失败，请重新加入');
  openJoin('join');
}

function ensureClient() {
  if (client) return client;
  client = DD.createClient({
    onState: (s, serverNow) => applyState(s, serverNow),
    onHello: (s) => {
      if (typeof s === 'number') seat = s;
      lastVersion = -1;
      saveSession();
    },
    onBanner: (text, warn) => setBanner(text, warn),
    onClosed: () => { DD.notice('房间已解散'); goHome(); },
    onRemoved: (reason) => {
      DD.notice(reason === 'kicked' ? '你已被房主移出房间' : '已退出房间');
      goHome();
    },
    onAuthFail: (e) => handleAuthFailure(e),
  });
  return client;
}

function connect() {
  if (!roomId || !token) return;
  ensureClient().sync(roomId, token);
}

/* ---------- 加入流程 ---------- */

function openJoin(mode) {
  pending = mode;
  const isJoin = mode === 'join';
  $('#modalTitle').textContent = mode === 'demo' ? '和4个机器人开局' : isJoin ? '加入牌桌' : '创建牌桌';
  $('#modalDesc').textContent = isJoin
    ? '输入房主发给你的 6 位房间码，再填昵称。'
    : mode === 'demo' ? '输入昵称，4 个机器人会自动入座并开局。' : '输入昵称后创建牌桌。';
  const codeInput = $('#roomCode');
  codeInput.style.display = isJoin ? 'block' : 'none';
  if (isJoin) codeInput.value = roomId || '';
  $('#joinModal').style.display = 'grid';
  setTimeout(() => {
    if (isJoin && !codeInput.value) codeInput.focus();
    else $('#nickname').focus();
  }, 60);
}

async function joinRoom(mode, name) {
  try {
    let r;
    if (mode === 'join') {
      r = await DD.api('join', { room: roomId, name, game: 'baohuang' });
    } else {
      r = await DD.api('create', { name, game: 'baohuang' });
      roomId = r.room;
    }
    if (r.room) roomId = r.room;
    seat = r.seat;
    token = r.token;
    lastVersion = -1;
    lastTurnKey = '';
    lastFinished = false;
    lastWindSeq = 0;
    windInitialized = false;
    lastHandKey = '';
    lastResultKey = '';
    selection.clear();
    saveSession();
    history.replaceState(null, '', '#room=' + roomId);
    showGame();
    applyState(r.state, r.state.serverNow);
    if (mode === 'demo') {
      try {
        for (let i = 0; i < 5; i++) {
          if (i === seat) continue;
          const b = await DD.api('addbot', { room: roomId, token, seat: i });
          applyState(b.state, b.state.serverNow);
        }
        const started = await DD.api('start', { room: roomId, token });
        applyState(started.state, started.state.serverNow);
      } catch (e) {
        DD.notice(e.message);
      }
    }
    connect();
  } catch (e) {
    DD.notice(e.message);
    if (mode === 'join') openJoin('join');
  }
}

/* ---------- 事件绑定 ---------- */

$('#demo').onclick = () => openJoin('demo');
$('#create').onclick = () => openJoin('create');
$('#joinRoomOpen').onclick = () => { roomId = ''; openJoin('join'); };
$('#copyInvite').onclick = () => copyInvite();
$('#homeLink').onclick = () => { location.href = '../'; };
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
      DD.notice('请输入 6 位房间码');
      $('#roomCode').focus();
      return;
    }
    roomId = code;
  }
  $('#joinModal').style.display = 'none';
  joinRoom(pending, name);
};
$('#playCards').onclick = playSelected;
$('#passTurn').onclick = passTurn;
$('#hint').onclick = useHint;
$('#nextGame').onclick = () => doAction('next');
$('#buy6List').addEventListener('click', (e) => {
  const b = e.target.closest('[data-buy6seller]');
  if (!b) return;
  DD.audio.ensure();
  doAction('buy6', { seller: Number(b.dataset.buy6seller) });
});
$('#windList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-wind]');
  if (!b) return;
  doAction('wind', { seat: Number(b.dataset.wind) });
});
$('#leaveGame').onclick = () => {
  if (!state) return;
  const msg = state.started ? '退出房间？剩下的牌会由机器人接管' : '退出房间？';
  if (!confirm(msg)) return;
  doAction('leave');
};
$('#dissolveGame').onclick = () => {
  if (!state || seat !== state.hostSeat) return;
  if (!confirm('强制解散房间？所有玩家都会退出')) return;
  doAction('dissolve');
};
$('#soundToggle').onclick = () => {
  DD.audio.toggle();
  updateSoundToggle();
};

$('#trickCenter').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lobby]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.lobby;
  if (action === 'kick') {
    if (!confirm('确定踢出该玩家？')) return;
    doAction('kick', { seat: Number(btn.dataset.seat) });
  } else if (action === 'leave') {
    if (!confirm('确定退出房间？')) return;
    doAction('leave');
  } else if (action === 'dissolve') {
    if (!confirm('确定解散房间？')) return;
    doAction('dissolve');
  } else if (action === 'ready') doAction('ready');
  else if (action === 'start') doAction('start');
  else if (action === 'copy') copyInvite();
  else if (action === 'addbot') doAction('addbot', { seat: Number(btn.dataset.seat) });
  else if (action === 'removebot') doAction('removebot', { seat: Number(btn.dataset.seat) });
  else if (action === 'sit') doAction('sit', { seat: Number(btn.dataset.seat) });
});

function updateSoundToggle() {
  const b = $('#soundToggle');
  if (!b) return;
  const muted = DD.audio.isMuted();
  b.textContent = muted ? '🔇' : '🔊';
  b.classList.toggle('off', muted);
  b.title = muted ? '点击开启提示音' : '点击静音';
}

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
window.addEventListener('online', () => connect());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { connect(); syncViewport(); }
});
window.addEventListener('orientationchange', onViewportChange);
window.addEventListener('resize', onViewportChange);
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);

/* ---------- 启动 ---------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try { navigator.serviceWorker.register('../sw.js?v=20').catch(() => {}); } catch {}
  });
}

updateSoundToggle();
syncViewport();
bindHandPointer();
DD.preloadCardFaces();

function bootFromSession() {
  const saved = session.load();
  if (!saved) return false;
  roomId = saved.room;
  seat = saved.seat ?? -1;
  token = saved.token;
  history.replaceState(null, '', '#room=' + roomId);
  showGame();
  connect();
  return true;
}

if (location.hash.startsWith('#room=')) {
  roomId = location.hash.slice(6).toUpperCase();
  const saved = session.load();
  if (saved && saved.room === roomId) {
    seat = saved.seat ?? -1;
    token = saved.token;
    showGame();
    connect();
  } else {
    token = '';
    openJoin('join');
  }
} else if (!bootFromSession()) {
  // 落地页等待创建或加入
}
