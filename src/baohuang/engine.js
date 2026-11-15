'use strict';
// 五人保皇房间状态机：发牌/买6 → 皇帝登基/让位 → 打牌/给风 → 结算。
// 身份由 token 推导，公开状态按座位裁剪（暗侍卫不外泄）。

const {
  SEATS, RANK_SIX, RANK_TWO,
  deal, countSix, choosePayment, payPriority, findTriples, findGuardHolder, nextSeat, prevSeat,
} = require('./cards');
const { analyze, beats, checkPlay, cardLabel, describeType, isBomb } = require('./rules');
const { GameError } = require('../errors');

const RANK_NAMES = ['头科', '二科', '三科', '二落', '大落'];

function isCard(c) {
  return c && typeof c === 'object' && typeof c.id === 'string' && Number.isInteger(c.rank) && Number.isInteger(c.suit);
}

function copyCards(cards) {
  return (cards || []).filter(isCard).map((c) => ({ ...c }));
}

function emptyRoomFields() {
  return {
    game: 'baohuang',
    numSeats: SEATS,
    phase: 'lobby',
    turn: 0,
    lead: null,
    passes: 0,
    passed: Array(SEATS).fill(false),
    playedBy: Array(SEATS).fill(null),
    candidateSeat: null,
    initialCandidateSeat: null,
    transferCount: 0,
    redealCount: 0,
    specialJokerId: null,
    specialSeat: null,
    emperorSeat: null,
    emperorTripleIds: [],
    emperorTripleCards: [],
    guardSeat: null,
    guardCardId: null,
    guardPublic: false,
    rankings: [],
    windGiverSeat: null,
    windSeq: 0,
    lastWind: null,
    buy6Log: [],
    winnerCamp: null,
    emperorWin: null,
  };
}

function ctxOf(r) {
  return { emperorIds: new Set(r.emperorTripleIds || []), guardId: r.guardCardId || null };
}

function roleOf(r, seat) {
  if (seat === r.emperorSeat) return 'emperor';
  if (seat === r.guardSeat) return 'guard';
  return 'revolution';
}

function campOf(r, seat) {
  return roleOf(r, seat) === 'emperor' || roleOf(r, seat) === 'guard' ? 'emperor' : 'revolution';
}

function buy6Buyers(r) {
  const out = [];
  r.players.forEach((p, i) => {
    if (p && countSix(p.hand) === 0) out.push(i);
  });
  return out;
}

function buy6Sellers(r) {
  const out = [];
  r.players.forEach((p, i) => {
    if (p && countSix(p.hand) > 1) out.push(i);
  });
  return out;
}

function buy6Actor(r) {
  const buyers = buy6Buyers(r);
  return buyers.length ? buyers[0] : null;
}

// 当前买家可选的支付牌：仅限最高优先档（多个2/多张同档王由玩家自行选择花色）
function buy6PayTier(hand) {
  let bestP = Infinity;
  for (const c of hand) {
    const p = payPriority(c);
    if (p >= 0 && p < bestP) bestP = p;
  }
  if (bestP === Infinity) return [];
  return hand.filter((c) => payPriority(c) === bestP);
}

function actorSeat(r) {
  if (!r.started || r.finished) return null;
  if (r.phase === 'buy6') return buy6Actor(r);
  if (r.phase === 'emperor') return r.candidateSeat;
  if (r.phase === 'wind') return r.windGiverSeat;
  if (r.phase === 'playing') return r.turn;
  return null;
}

function needsAction(r) {
  return actorSeat(r) != null;
}

function seatName(r, seat) {
  return r.players[seat]?.name || `${seat + 1}号位`;
}

function resetRoundState(r) {
  r.turn = 0;
  r.lead = null;
  r.passes = 0;
  r.passed = Array(SEATS).fill(false);
  r.playedBy = Array(SEATS).fill(null);
  r.rankings = [];
  r.windGiverSeat = null;
  r.lastWind = null;
  r.winnerCamp = null;
  r.emperorWin = null;
  r.candidateSeat = null;
  r.initialCandidateSeat = null;
  r.transferCount = 0;
  r.specialJokerId = null;
  r.specialSeat = null;
  r.emperorSeat = null;
  r.emperorTripleIds = [];
  r.emperorTripleCards = [];
  r.guardSeat = null;
  r.guardCardId = null;
  r.guardPublic = false;
  r.buy6Log = [];
  r.players.forEach((p) => {
    if (!p) return;
    p.done = false;
    p.rank = null;
    p.hand = [];
  });
}

function dealNewRound(r) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const dealt = deal(SEATS);
    const hands = dealt.hands;
    const buyers = [];
    const sellers = [];
    hands.forEach((hand, i) => {
      const n = countSix(hand);
      if (n === 0) buyers.push(i);
      else if (n > 1) sellers.push(i);
    });
    // 任何买家没有支付牌（2/小王/大王）→ 本局重新发牌
    if (buyers.some((seat) => !choosePayment(hands[seat]))) {
      r.redealCount = (r.redealCount || 0) + 1;
      if (attempt > 400) throw new GameError('deal-failed', '发牌失败，请重试', 500);
      continue;
    }

    r.players.forEach((p, i) => {
      p.hand = hands[i];
      p.done = false;
      p.rank = null;
    });
    r.specialJokerId = dealt.specialJokerId;
    r.specialSeat = dealt.specialSeat;
    r.initialCandidateSeat = dealt.specialSeat;
    r.candidateSeat = dealt.specialSeat;
    r.transferCount = 0;
    r.buy6Log = [];
    r.lead = null;
    r.passes = 0;
    r.passed = Array(SEATS).fill(false);
    r.playedBy = Array(SEATS).fill(null);

    r.log.push(`第${(r.gamesPlayed || 0) + 1}小局发牌完成：${dealt.sizes.join('/')}`);
    r.log.push(`特殊大王标记最初在${seatName(r, r.specialSeat)}手中，获得皇帝选择权`);
    if (buyers.length) {
      r.phase = 'buy6';
      r.turn = buyers[0];
      r.log.push(`买6开始：${buyers.map((s) => seatName(r, s)).join('、')} 需要买6；${sellers.map((s) => `${seatName(r, s)}（多${countSix(hands[s]) - 1}张）`).join('、')} 出售多余6`);
    } else {
      r.phase = 'emperor';
      r.turn = dealt.specialSeat;
      r.log.push('每人恰好一张6，买6完成');
    }
    return;
  }
}

function startGame(r) {
  resetRoundState(r);
  r.gamesPlayed = 0;
  r.started = true;
  r.finished = false;
  r.redealCount = 0;
  r.log.push('保皇开局');
  dealNewRound(r);
}

function nextGame(r) {
  if (!r.finished) throw new GameError('finished', '本局尚未结束', 409);
  resetRoundState(r);
  r.finished = false;
  dealNewRound(r);
}

function validTriples(r, seat) {
  return r.players[seat] ? findTriples(r.players[seat].hand) : [];
}

function redeal(r, reason) {
  if (reason) r.log.push(reason);
  r.redealCount = (r.redealCount || 0) + 1;
  r.phase = 'dealing';
  resetRoundStateKeepLog(r);
  r.finished = false;
  dealNewRound(r);
}

function resetRoundStateKeepLog(r) {
  r.turn = 0;
  r.lead = null;
  r.passes = 0;
  r.passed = Array(SEATS).fill(false);
  r.playedBy = Array(SEATS).fill(null);
  r.candidateSeat = null;
  r.initialCandidateSeat = null;
  r.transferCount = 0;
  r.specialJokerId = null;
  r.specialSeat = null;
  r.emperorSeat = null;
  r.emperorTripleIds = [];
  r.emperorTripleCards = [];
  r.guardSeat = null;
  r.guardCardId = null;
  r.guardPublic = false;
  r.buy6Log = [];
  r.windGiverSeat = null;
  r.players.forEach((p) => {
    if (!p) return;
    p.hand = [];
    p.done = false;
    p.rank = null;
  });
}

function enthrone(r, seat, triple) {
  const guard = findGuardHolder(r.players.map((p) => p.hand), triple, seat);
  if (!guard) throw new GameError('bad-emperor', '第四张牌不存在，请重新选牌', 400);
  r.emperorSeat = seat;
  r.emperorTripleIds = triple.cards.map((c) => c.id);
  r.emperorTripleCards = copyCards(triple.cards);
  r.guardSeat = guard.seat;
  r.guardCardId = guard.cardId;
  r.guardPublic = false;
  r.phase = 'playing';
  r.turn = seat;
  r.lead = null;
  r.passes = 0;
  r.passed = Array(SEATS).fill(false);
  r.playedBy = Array(SEATS).fill(null);
  r.log.push(`${seatName(r, seat)} 登基称帝`);
  r.log.push(`皇帝亮出皇炸：三张${cardLabel(triple.cards[0])}`);
  r.log.push('侍卫身份已确定（暗侍卫）');
}

function yieldEmperor(r, seat) {
  r.transferCount = (r.transferCount || 0) + 1;
  const from = seat;
  const to = prevSeat(from, SEATS);
  let paid = null;
  if (r.transferCount >= 2) {
    const p = r.players[from];
    const two = p.hand.find((c) => c.rank === RANK_TWO);
    if (!two) {
      redeal(r, `${seatName(r, from)} 让位时没有2可上贡，本局重新发牌`);
      return;
    }
    p.hand.splice(p.hand.findIndex((c) => c.id === two.id), 1);
    r.players[to].hand.push(two);
    paid = two;
  }
  r.candidateSeat = to;
  r.turn = to;
  r.log.push(`${seatName(r, from)} 让位给${seatName(r, to)}${paid ? `，上贡${cardLabel(paid)}` : ''}`);
  if (r.transferCount >= SEATS) {
    // 最后一位让位者上贡的2可能刚好凑成三张同花色同点数：此时必须由新候选登基，不能重新发牌
    if (validTriples(r, to).length) {
      r.log.push(`${seatName(r, to)} 获得上贡后满足登基条件，必须登基`);
      return;
    }
    redeal(r, '五位玩家均未满足登基条件，本局重新发牌');
  }
}

function autoEmperor(r, prefix) {
  const seat = r.candidateSeat;
  if (seat == null || !r.players[seat]) return;
  const triples = validTriples(r, seat);
  if (triples.length) {
    r.log.push(`${prefix}${seatName(r, seat)} 自动登基`);
    enthrone(r, seat, triples[0]);
  } else {
    r.log.push(`${prefix}${seatName(r, seat)} 自动让位`);
    yieldEmperor(r, seat);
  }
}

function finishBuy6(r) {
  r.phase = 'emperor';
  r.turn = r.candidateSeat;
  r.lead = null;
  r.passes = 0;
  r.passed = Array(SEATS).fill(false);
  r.playedBy = Array(SEATS).fill(null);
  r.log.push('买6完成，进入皇帝与侍卫确认');
}

function doBuy6(r, seat, payload = {}, prefix = '') {
  if (r.phase !== 'buy6') throw new GameError('bad-phase', '当前不是买6阶段', 409);
  const actor = buy6Actor(r);
  if (actor == null) { finishBuy6(r); return; }
  if (seat !== actor) throw new GameError('not-turn', '还没轮到你买6', 409);
  const p = r.players[seat];
  if (countSix(p.hand) !== 0) throw new GameError('bad-buy6', '你不需要买6', 400);
  const seller = Number(payload.seller);
  const sp = r.players[seller];
  if (!Number.isInteger(seller) || seller < 0 || seller >= SEATS || !sp) {
    throw new GameError('bad-target', '请选择出售6的玩家', 400);
  }
  if (countSix(sp.hand) < 2) throw new GameError('bad-target', '该玩家没有多余的6', 400);
  const best = choosePayment(p.hand);
  if (!best) {
    redeal(r, `${seatName(r, seat)} 没有2/王可支付，本局重新发牌`);
    return;
  }
  const ids = Array.isArray(payload.cards) ? payload.cards.map(String) : [];
  if (ids.length > 1) throw new GameError('bad-cards', '买6只能支付一张牌', 400);
  const chosen = ids.length ? p.hand.find((c) => c.id === ids[0]) : best;
  if (!chosen || payPriority(chosen) < 0) throw new GameError('bad-cards', '请选择2、小王或大王支付', 400);
  if (payPriority(chosen) !== payPriority(best)) {
    throw new GameError('bad-cards', '支付牌必须优先使用2、小王、大王');
  }
  const six = sp.hand.find((c) => c.rank === RANK_SIX);
  if (!six) {
    redeal(r, '买6时未找到6，本局重新发牌');
    return;
  }
  p.hand = p.hand.filter((c) => c.id !== chosen.id);
  sp.hand = sp.hand.filter((c) => c.id !== six.id);
  p.hand.push(six);
  sp.hand.push(chosen);
  r.buy6Log.push({ buyer: seat, seller, paid: { ...chosen }, sixId: six.id });
  r.log.push(`${prefix}${seatName(r, seat)} 用${cardLabel(chosen)}向${seatName(r, seller)}买6`);
  if (buy6Actor(r) == null) finishBuy6(r);
  else r.turn = buy6Actor(r);
}

function autoBuy6(r, prefix) {
  const seat = buy6Actor(r);
  if (seat == null) { finishBuy6(r); return; }
  const payment = choosePayment(r.players[seat].hand);
  if (!payment) {
    redeal(r, `${seatName(r, seat)} 没有2/王可支付，本局重新发牌`);
    return;
  }
  const sellers = buy6Sellers(r);
  if (!sellers.length) {
    redeal(r, '没有玩家可出售多余的6，本局重新发牌');
    return;
  }
  doBuy6(r, seat, { seller: sellers[0], cards: [payment.id] }, prefix);
}

function validWindTargets(r) {
  return r.players.map((p, i) => ({ p, i })).filter(({ p, i }) => p && !p.done && p.hand.length && i !== r.windGiverSeat).map(({ i }) => i);
}

function windAction(r, seat, targetSeat, prefix) {
  if (r.phase !== 'wind') throw new GameError('bad-phase', '当前不是给风阶段', 409);
  if (seat !== r.windGiverSeat) throw new GameError('not-turn', '还没轮到你给风', 409);
  const target = Number(targetSeat);
  const tp = r.players[target];
  if (!Number.isInteger(target) || target < 0 || target >= SEATS || !tp || tp.done || !tp.hand.length) {
    throw new GameError('bad-target', '请选择一位仍有手牌的玩家', 400);
  }
  const giverName = seatName(r, seat);
  const targetName = seatName(r, target);
  r.lastWind = { seat: target, leader: seat, giver: seat, seq: (r.windSeq || 0) + 1 };
  r.windSeq = r.lastWind.seq;
  r.phase = 'playing';
  r.turn = target;
  r.lead = null;
  r.passes = 0;
  r.passed = Array(SEATS).fill(false);
  r.playedBy = Array(SEATS).fill(null);
  r.windGiverSeat = null;
  r.log.push(`${prefix || ''}${giverName} 给风${targetName}，由${targetName}领出`);
}

function autoWind(r, prefix, preferGuard) {
  const seat = r.windGiverSeat;
  if (seat == null) return;
  const options = validWindTargets(r);
  if (!options.length) {
    settleFromState(r);
    return;
  }
  let target = null;
  if (preferGuard && seat === r.emperorSeat && r.guardPublic
    && options.includes(r.guardSeat)) {
    target = r.guardSeat;
  }
  if (target == null) {
    for (let step = 1; step <= SEATS; step++) {
      const cand = (seat + step) % SEATS;
      if (options.includes(cand)) { target = cand; break; }
    }
  }
  if (target == null) target = options[0];
  windAction(r, seat, target, prefix);
}

function campDone(r, camp) {
  for (let i = 0; i < SEATS; i++) {
    if (!r.players[i]) continue;
    if (campOf(r, i) !== camp) continue;
    if (!r.players[i].done) return false;
  }
  return true;
}

function judgeEmperorWin(r) {
  const er = r.players[r.emperorSeat]?.rank;
  const gr = r.players[r.guardSeat]?.rank;
  if (!er || !gr) return false;
  return Math.min(er, gr) === 1 && Math.max(er, gr) <= 3;
}

function settleFromState(r) {
  let camp;
  if (campDone(r, 'revolution')) camp = 'revolution';
  else if (campDone(r, 'emperor')) camp = judgeEmperorWin(r) ? 'emperor' : 'revolution';
  else camp = 'revolution';
  settle(r, camp);
}

function settle(r, camp) {
  r.phase = 'settlement';
  r.finished = true;
  r.guardPublic = true;
  r.winnerCamp = camp;
  r.emperorWin = camp === 'emperor';
  r.gamesPlayed = (r.gamesPlayed || 0) + 1;
  r.turnDeadline = null;
  r.windGiverSeat = null;
  r.lead = null;
  r.passes = 0;
  r.passed = Array(SEATS).fill(false);
  const rankingText = r.rankings.map((s, i) => `${RANK_NAMES[i]}：${seatName(r, s)}`).join('；');
  const rest = r.players.map((p, i) => ({ p, i })).filter(({ p }) => p && !p.done)
    .map(({ i }) => `${seatName(r, i)}（未出完）`).join('；');
  r.log.push(`本局结束：${camp === 'emperor' ? '皇帝阵营' : '革命党'}获胜`);
  r.log.push(`排名：${rankingText}${rest ? `；${rest}` : ''}`);
}

function finishForPlayer(r, seat) {
  const p = r.players[seat];
  p.done = true;
  p.rank = r.rankings.length + 1;
  r.rankings.push(seat);
  r.log.push(`${seatName(r, seat)} 出完，第${p.rank}名（${RANK_NAMES[p.rank - 1]}）`);

  if (campDone(r, 'revolution')) {
    settle(r, 'revolution');
    return;
  }
  if (campDone(r, 'emperor')) {
    settle(r, judgeEmperorWin(r) ? 'emperor' : 'revolution');
    return;
  }
  // 给风：给风者所在阵营仍有手牌；失败方/对方阵营也可接风（由玩家自选）。
  r.phase = 'wind';
  r.windGiverSeat = seat;
  r.turn = seat;
  r.log.push(`${seatName(r, seat)} 打出最后一张6，请选择给风对象`);
}

function nextActive(r, from) {
  for (let step = 1; step <= SEATS; step++) {
    const s = (from + step) % SEATS;
    const p = r.players[s];
    if (p && !p.done && !r.passed[s]) {
      r.turn = s;
      return s;
    }
  }
  return null;
}

function leadResponders(r, leader) {
  let n = 0;
  for (let i = 0; i < SEATS; i++) {
    const p = r.players[i];
    if (i !== leader && p && !p.done && !r.passed[i]) n++;
  }
  return n;
}

function cannotBeatMessage(type, target) {
  if (target.kind === 'six') return '6 不能被任何牌压制';
  if (type.kind === 'six') return '6 不能用来压牌';
  if (isBomb(type) && isBomb(target)) return '当前炸弹无法压制上家炸弹';
  if (type.kind === 'combo' && target.kind === 'combo') {
    if (type.n !== target.n) return '出牌张数不一致';
    const ln = Math.min(type.normals.length, target.normals.length);
    for (let i = 0; i < ln; i++) {
      if (!(type.normals[i] > target.normals[i])) return '普通牌部分未能大于上家';
    }
    return '混儿部分未能达到上家混儿牌力';
  }
  return '这手牌压不过上家';
}

function doPlay(r, seat, cards) {
  const p = r.players[seat];
  const check = checkPlay(cards, p.hand, ctxOf(r));
  if (!check.ok) throw new GameError('bad-cards', check.error, 400);
  const type = check.type;
  const target = r.lead && r.lead.seat !== seat ? r.lead : null;
  // 最后一张6是特殊的“走人”牌，即使跟牌时也允许直接打出；打完即给风。
  if (target && type.kind !== 'six' && !beats(type, target)) {
    throw new GameError('cannot-beat', cannotBeatMessage(type, target), 400);
  }

  const ids = new Set(cards.map((c) => c.id));
  p.hand = p.hand.filter((c) => !ids.has(c.id));
  r.playedBy[seat] = copyCards(cards);
  r.lead = { seat, ...type, cards: copyCards(cards) };
  r.passes = 0;
  r.passed[seat] = false;
  r.lead.responders = leadResponders(r, seat);

  if (r.guardCardId && !r.guardPublic && cards.some((c) => c.id === r.guardCardId)) {
    r.guardPublic = true;
    r.log.push(`${seatName(r, seat)} 打出侍卫牌，侍卫身份公开`);
  }
  r.log.push(`${seatName(r, seat)} 出了 ${describeType(type)}`);

  if (!p.hand.length) {
    finishForPlayer(r, seat);
    return;
  }
  if (nextActive(r, seat) == null) {
    endRound(r, seat);
  }
}

function doPass(r, seat) {
  if (!r.lead || r.lead.seat === seat) throw new GameError('no-lead', '当前没有上家牌，不能不要', 400);
  r.passed[seat] = true;
  r.playedBy[seat] = null; // 不要后不再显示本轮早先出的牌，避免误认领出
  r.passes += 1;
  r.log.push(`${seatName(r, seat)} 不要`);
  const responders = r.lead.responders || 0;
  if (r.passes >= responders) {
    endRound(r, r.lead.seat);
    return;
  }
  if (nextActive(r, seat) == null) {
    endRound(r, r.lead.seat);
  }
}

function endRound(r, leader) {
  r.lead = null;
  r.passes = 0;
  r.passed = Array(SEATS).fill(false);
  r.playedBy = Array(SEATS).fill(null);
  r.turn = leader;
  if (r.players[leader]?.done) {
    if (nextActive(r, leader) == null) {
      settleFromState(r);
      return;
    }
  }
  r.log.push('本轮结束，最后出牌者领出');
}

function applyAction(r, seat, action, payload = {}) {
  const p = r.players[seat];
  if (!p) throw new GameError('auth', '身份验证失败，请重新加入', 401);
  if (p.bot) throw new GameError('auth', '机器人座位由系统操作', 403);

  if (action === 'emperor') {
    if (r.phase !== 'emperor') throw new GameError('bad-phase', '当前不是皇帝确认阶段', 409);
    if (seat !== r.candidateSeat) throw new GameError('not-turn', '还没轮到你确认皇帝', 409);
    const triples = validTriples(r, seat);
    if (payload.yield) {
      if (triples.length) throw new GameError('must-enthrone', '你已满足登基条件，必须登基', 400);
      yieldEmperor(r, seat);
      return true;
    }
    const ids = Array.isArray(payload.cards) ? payload.cards.map(String) : [];
    const cards = ids.map((id) => p.hand.find((c) => c.id === id)).filter(Boolean);
    if (cards.length !== 3 || new Set(ids).size !== 3) throw new GameError('bad-cards', '请选择三张牌登基', 400);
    const wanted = cards.map((c) => c.id).sort().join(',');
    const triple = triples.find((t) => t.cards.map((c) => c.id).sort().join(',') === wanted);
    if (!triple) throw new GameError('bad-emperor', '需要三张同花色、同点数的牌', 400);
    enthrone(r, seat, triple);
    return true;
  }

  if (r.phase === 'buy6' && action === 'buy6') {
    doBuy6(r, seat, payload, '');
    return true;
  }

  if (r.phase === 'wind' && action === 'wind') {
    windAction(r, seat, payload.seat, '');
    return true;
  }

  if (r.phase !== 'playing') throw new GameError('bad-phase', '当前不能出牌', 409);
  if (seat !== r.turn) throw new GameError('not-turn', '还没轮到你', 409);

  if (action === 'pass') {
    doPass(r, seat);
    return true;
  }
  if (action === 'play') {
    const ids = Array.isArray(payload.cards) ? payload.cards.map(String) : [];
    if (new Set(ids).size !== ids.length) throw new GameError('bad-cards', '不能重复选择同一张牌', 400);
    const cards = ids.map((id) => p.hand.find((c) => c.id === id)).filter(Boolean);
    if (!cards.length || cards.length !== ids.length) throw new GameError('bad-cards', '请选择手牌', 400);
    doPlay(r, seat, cards);
    return true;
  }

  throw new GameError('bad-cards', '未知操作', 400);
}

/* ---------- 机器人 ---------- */

function wildCards(hand) {
  return hand.filter((c) => c.rank === RANK_TWO || c.rank >= 16);
}

function comboCost(r, cards, type, target) {
  let cost = 0;
  const ids = new Set(cards.map((c) => c.id));
  if (type.kind === 'six') cost += 100;
  if (cards.some((c) => c.id === r.guardCardId)) cost += 40;
  if (cards.some((c) => (r.emperorTripleIds || []).includes(c.id))) cost += 40;
  if (cards.some((c) => c.rank === RANK_TWO || c.rank >= 16)) cost += 6 * cards.length;
  // 拆散同点数组的代价
  const byRank = new Map();
  for (const c of r.players[r.turn]?.hand || []) byRank.set(c.rank, (byRank.get(c.rank) || 0) + 1);
  for (const c of cards) {
    const total = byRank.get(c.rank) || 0;
    if (total > 1 && ids.size < total) cost += 2;
  }
  if (cards.length > 1) cost += 0.5;
  if (target) cost += 0;
  cost += (type.power || 0) / 1000;
  return cost;
}

function botCandidates(r, seat) {
  const p = r.players[seat];
  const hand = p.hand;
  const lead = r.lead && r.lead.seat !== seat ? r.lead : null;
  const ctx = ctxOf(r);
  const out = [];
  const seen = new Set();
  const add = (cards) => {
    if (!cards || !cards.length) return;
    const key = cards.map((c) => c.id).sort().join(',');
    if (seen.has(key)) return;
    const type = analyze(cards, ctx);
    if (!type) return;
    const sixes = cards.filter((c) => c.rank === RANK_SIX).length;
    if (sixes && (cards.length !== 1 || hand.length !== 1)) return;
    if (lead && type.kind !== 'six' && !beats(type, lead)) return;
    seen.add(key);
    out.push({ cards: cards.slice(), type, cost: comboCost(r, cards, type, lead) });
  };

  // 单张
  for (const c of hand) add([c]);

  // 同点数普通牌（含 4+ 套牌；2 也可作为最大普通牌成组）
  const byRank = new Map();
  for (const c of hand) {
    if (c.rank < 7 || c.rank > RANK_TWO) continue;
    if (!byRank.has(c.rank)) byRank.set(c.rank, []);
    byRank.get(c.rank).push(c);
  }
  for (const group of byRank.values()) {
    for (let n = 2; n <= group.length; n++) add(group.slice(0, n));
  }

  // 皇炸拆出的对子/三张
  const emperor = hand.filter((c) => (r.emperorTripleIds || []).includes(c.id));
  for (let n = 2; n <= 3; n++) if (emperor.length >= n) add(emperor.slice(0, n));

  // 王炸与双王对
  for (const rank of [16, 17]) {
    const group = hand.filter((c) => c.rank === rank);
    for (let n = 2; n <= group.length; n++) add(group.slice(0, n));
  }

  // 四张同花色炸弹
  const suitGroups = new Map();
  for (const c of hand) {
    if (c.rank < 7 || c.rank > RANK_TWO) continue;
    const key = `${c.suit}-${c.rank}`;
    if (!suitGroups.has(key)) suitGroups.set(key, []);
    suitGroups.get(key).push(c);
  }
  for (const group of suitGroups.values()) if (group.length === 4) add(group);

  // 带混儿的组合（跟牌时必须同张数；领出时补到自然长度）
  const twos = hand.filter((c) => c.rank === RANK_TWO && !(r.emperorTripleIds || []).includes(c.id));
  const kings = hand.filter((c) => c.rank >= 16);
  const nTarget = lead ? lead.n : 0;
  for (const [rank, group] of byRank) {
    const isTwoGroup = rank === RANK_TWO;
    const wildPool = isTwoGroup ? kings.length : twos.length + kings.length;
    const maxN = lead ? Math.min(hand.length, nTarget) : Math.min(hand.length, group.length + wildPool);
    for (let n = 2; n <= maxN; n++) {
      for (let k = 1; k <= Math.min(group.length, n); k++) {
        const w = n - k;
        if (w === 0) continue; // 纯普通牌已在上面生成
        if (!isTwoGroup && twos.length >= w) add([...group.slice(0, k), ...twos.slice(0, w)]);
        if (kings.length >= w) add([...group.slice(0, k), ...kings.slice(0, w)]);
      }
    }
  }
  return out;
}

function botPlay(r) {
  const seat = r.turn;
  const lead = r.lead && r.lead.seat !== seat ? r.lead : null;
  const cands = botCandidates(r, seat);
  if (!cands.length) {
    doPass(r, seat);
    return;
  }
  cands.sort((a, b) => a.cost - b.cost);
  doPlay(r, seat, cands[0].cards);
}

function autoPlay(r, prefix) {
  const seat = r.turn;
  const lead = r.lead && r.lead.seat !== seat ? r.lead : null;
  if (lead) {
    r.log.push(`${prefix}${seatName(r, seat)} 不要`);
    doPass(r, seat);
    return;
  }
  const p = r.players[seat];
  const playable = p.hand.filter((c) => c.rank !== RANK_SIX || p.hand.length === 1);
  if (!playable.length) return;
  const card = playable.slice().sort((a, b) => a.rank - b.rank || a.suit - b.suit)[0];
  r.log.push(`${prefix}${seatName(r, seat)} 自动出最小单张`);
  doPlay(r, seat, [card]);
}

function onTimeout(r) {
  if (r.phase === 'buy6') autoBuy6(r, '超时，');
  else if (r.phase === 'emperor') autoEmperor(r, '超时，');
  else if (r.phase === 'wind') autoWind(r, '超时，', true);
  else if (r.phase === 'playing') autoPlay(r, '超时，');
}

function onBot(r) {
  if (r.phase === 'buy6') autoBuy6(r, '');
  else if (r.phase === 'emperor') autoEmperor(r, '');
  else if (r.phase === 'wind') autoWind(r, '', true);
  else if (r.phase === 'playing') botPlay(r);
}

/* ---------- 公开状态 ---------- */

function publicState(r, seat, helpers = {}) {
  const isOnline = helpers.isOnline || (() => false);
  const config = helpers.config || {};
  const canStart = helpers.canStart || (() => false);
  const revealed = !!r.guardPublic || !!r.finished || (seat >= 0 && seat === r.guardSeat);
  const yourRole = seat >= 0 ? roleOf(r, seat) : null;
  const players = r.players.map((p, i) => {
    if (!p) return null;
    const role = i === r.emperorSeat ? 'emperor' : (i === r.guardSeat && revealed ? 'guard' : null);
    return {
      seat: i,
      name: p.name,
      bot: !!p.bot,
      ready: !!p.ready,
      done: !!p.done,
      count: p.hand.length,
      online: isOnline(r, i),
      lastPlay: r.playedBy?.[i] || null,
      rank: Number.isInteger(p.rank) ? p.rank : null,
      role,
      candidate: i === r.candidateSeat,
      emperor: i === r.emperorSeat,
      guard: i === r.guardSeat && revealed,
      remaining: r.finished ? copyCards(p.hand) : null,
    };
  });
  const windOptions = r.phase === 'wind' ? validWindTargets(r) : [];
  return {
    id: r.id,
    game: 'baohuang',
    numSeats: SEATS,
    players,
    yourSeat: seat,
    hand: copyCards(r.players[seat]?.hand),
    started: !!r.started,
    finished: !!r.finished,
    closed: !!r.closed,
    phase: r.phase,
    turn: r.turn,
    lead: r.lead,
    passes: r.passes,
    passed: (r.passed || []).slice(),
    actorSeat: actorSeat(r),
    candidateSeat: r.candidateSeat,
    initialCandidateSeat: r.initialCandidateSeat,
    transferCount: r.transferCount || 0,
    specialJokerId: r.specialJokerId,
    specialSeat: r.specialSeat,
    emperorSeat: r.emperorSeat,
    emperorTripleIds: (r.emperorTripleIds || []).slice(),
    emperorTripleCards: copyCards(r.emperorTripleCards),
    guardSeat: revealed ? r.guardSeat : (seat >= 0 && seat === r.guardSeat ? r.guardSeat : null),
    guardCardId: revealed || (seat >= 0 && seat === r.guardSeat) ? r.guardCardId : null,
    guardPublic: !!r.guardPublic,
    yourRole,
    rankings: (r.rankings || []).slice(),
    windGiverSeat: r.windGiverSeat,
    windOptions,
    lastWind: r.lastWind || null,
    buy6Log: r.buy6Log || [],
    buy6Seat: r.phase === 'buy6' ? buy6Actor(r) : null,
    buy6Buyers: r.phase === 'buy6' ? buy6Buyers(r) : [],
    buy6Sellers: r.phase === 'buy6'
      ? buy6Sellers(r).map((s) => ({ seat: s, extra: countSix(r.players[s].hand) - 1 }))
      : [],
    buy6PayIds: r.phase === 'buy6' && seat === buy6Actor(r)
      ? buy6PayTier(r.players[seat]?.hand || []).map((c) => c.id)
      : [],
    buy6PaymentId: r.phase === 'buy6' && seat === buy6Actor(r)
      ? ((choosePayment(r.players[seat]?.hand || []) || {}).id || null)
      : null,
    winnerCamp: r.winnerCamp,
    emperorWin: r.emperorWin,
    log: (r.log || []).slice(-14),
    canStart: canStart(r),
    hostSeat: r.hostSeat,
    version: r.version,
    turnDeadline: r.turnDeadline ?? null,
    serverNow: Date.now(),
    turnSeconds: config.TURN_SECONDS,
  };
}

/* ---------- 持久化 ---------- */

function serialize(r) {
  return {
    phase: r.phase,
    candidateSeat: r.candidateSeat,
    initialCandidateSeat: r.initialCandidateSeat,
    transferCount: r.transferCount || 0,
    redealCount: r.redealCount || 0,
    specialJokerId: r.specialJokerId,
    specialSeat: r.specialSeat,
    emperorSeat: r.emperorSeat,
    emperorTripleIds: r.emperorTripleIds || [],
    emperorTripleCards: r.emperorTripleCards || [],
    guardSeat: r.guardSeat,
    guardCardId: r.guardCardId,
    guardPublic: !!r.guardPublic,
    rankings: r.rankings || [],
    windGiverSeat: r.windGiverSeat,
    windSeq: r.windSeq || 0,
    lastWind: r.lastWind || null,
    buy6Log: r.buy6Log || [],
    winnerCamp: r.winnerCamp,
    emperorWin: r.emperorWin,
  };
}

function normalize(r, rec) {
  const seats = SEATS;
  const phase = ['lobby', 'dealing', 'buy6', 'emperor', 'playing', 'wind', 'settlement'].includes(rec.phase)
    ? rec.phase : (rec.finished ? 'settlement' : rec.started ? 'playing' : 'lobby');
  // 发牌是同步完成的，不会成为持久化停留阶段；买6为手动阶段，可恢复。
  r.phase = phase === 'dealing' ? 'emperor' : phase;
  const seatOrNull = (v) => (Number.isInteger(v) && v >= 0 && v < seats ? v : null);
  r.candidateSeat = seatOrNull(rec.candidateSeat);
  r.initialCandidateSeat = seatOrNull(rec.initialCandidateSeat);
  r.transferCount = Number(rec.transferCount) || 0;
  r.redealCount = Number(rec.redealCount) || 0;
  r.specialJokerId = typeof rec.specialJokerId === 'string' ? rec.specialJokerId : null;
  r.specialSeat = seatOrNull(rec.specialSeat);
  r.emperorSeat = seatOrNull(rec.emperorSeat);
  r.emperorTripleIds = Array.isArray(rec.emperorTripleIds) ? rec.emperorTripleIds.filter((x) => typeof x === 'string') : [];
  r.emperorTripleCards = Array.isArray(rec.emperorTripleCards) ? copyCards(rec.emperorTripleCards) : [];
  r.guardSeat = seatOrNull(rec.guardSeat);
  r.guardCardId = typeof rec.guardCardId === 'string' ? rec.guardCardId : null;
  r.guardPublic = !!rec.guardPublic;
  r.rankings = Array.isArray(rec.rankings) ? rec.rankings.filter((x) => Number.isInteger(x) && x >= 0 && x < seats) : [];
  r.windGiverSeat = seatOrNull(rec.windGiverSeat);
  r.windSeq = Number(rec.windSeq) || 0;
  r.lastWind = rec.lastWind && Number.isInteger(rec.lastWind.seat)
    ? { seat: rec.lastWind.seat, leader: rec.lastWind.leader ?? null, giver: rec.lastWind.giver ?? null, seq: Number(rec.lastWind.seq) || 0 }
    : null;
  r.buy6Log = Array.isArray(rec.buy6Log) ? rec.buy6Log.filter((x) => x && Number.isInteger(x.buyer) && Number.isInteger(x.seller)) : [];
  r.winnerCamp = rec.winnerCamp === 'emperor' || rec.winnerCamp === 'revolution' ? rec.winnerCamp : null;
  r.emperorWin = typeof rec.emperorWin === 'boolean' ? rec.emperorWin : null;

  r.log = Array.isArray(rec.log) ? rec.log.slice(-200).map(String) : [];
  r.lead = rec.lead && typeof rec.lead === 'object' && Array.isArray(rec.lead.cards) ? { ...rec.lead } : null;
  r.passes = Number(rec.passes) || 0;
  r.playedBy = Array.from({ length: seats }, (_, i) => (Array.isArray(rec.playedBy?.[i]) ? copyCards(rec.playedBy[i]) : null));
  r.passed = Array.from({ length: seats }, (_, i) => !!(rec.passed && rec.passed[i]));
  r.windGiverSeat = seatOrNull(rec.windGiverSeat);

  // 修复：当前阶段必须有一个合法操作者
  if (r.started && !r.finished) {
    if (r.phase === 'buy6' && buy6Actor(r) == null) {
      r.phase = 'emperor';
      if (r.candidateSeat == null) r.candidateSeat = r.players.findIndex(Boolean);
      r.turn = r.candidateSeat;
    }
    if (r.phase === 'emperor' && (r.candidateSeat == null || !r.players[r.candidateSeat])) {
      r.candidateSeat = r.players.findIndex(Boolean);
    }
    if (r.phase === 'playing' && (r.turn == null || !r.players[r.turn] || r.players[r.turn].done)) {
      const active = r.players.findIndex((p) => p && !p.done);
      r.turn = active >= 0 ? active : 0;
    }
    if (r.phase === 'wind' && (r.windGiverSeat == null || !r.players[r.windGiverSeat])) {
      r.windGiverSeat = r.rankings.length ? r.rankings[r.rankings.length - 1] : 0;
    }
  }
  return r;
}

module.exports = {
  emptyRoomFields,
  startGame,
  nextGame,
  applyAction,
  actorSeat,
  needsAction,
  onTimeout,
  onBot,
  publicState,
  serialize,
  normalize,
  // 测试导出
  ctxOf,
  roleOf,
  campOf,
  validTriples,
  judgeEmperorWin,
};
