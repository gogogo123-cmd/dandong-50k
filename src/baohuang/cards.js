'use strict';
// 保皇牌库：157 张、发牌、买6、皇帝三张与侍卫识别。
// 点数沿用五十K编号：6=6，7~14=7~A，15=2，16=小王，17=大王。

const SEATS = 5;
const RANK_SIX = 6;
const RANK_TWO = 15;
const RANK_SMALL = 16;
const RANK_BIG = 17;

function buildDeck() {
  const cards = [];
  // 四副牌：7 ~ 2 各 16 张（每副每种花色一张）
  for (let copy = 0; copy < 4; copy++) {
    for (let suit = 0; suit < 4; suit++) {
      for (let rank = 7; rank <= 15; rank++) {
        cards.push({ id: `${copy}-${suit}-${rank}`, rank, suit });
      }
    }
  }
  // 大小王各 4 张
  for (let copy = 0; copy < 4; copy++) {
    cards.push({ id: `${copy}-4-${RANK_BIG}`, rank: RANK_BIG, suit: 4, big: true });
    cards.push({ id: `${copy}-4-${RANK_SMALL}`, rank: RANK_SMALL, suit: 4, big: false });
  }
  // 6 只保留 5 张
  for (let i = 0; i < 5; i++) {
    cards.push({ id: `six-${i}`, rank: RANK_SIX, suit: i % 4 });
  }
  return cards;
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// 发牌：两人 32 张、三人 31 张；随机决定哪两个座位拿 32 张。
// 发完牌后随机标记一张大王为“特殊大王”，其持有者是皇帝候选人。
function deal(seats = SEATS) {
  const deck = shuffle(buildDeck());
  const bigs = deck.filter((c) => c.rank === RANK_BIG);
  const special = bigs[Math.floor(Math.random() * bigs.length)];
  special.special = true;

  const sizes = [];
  const twoLong = [0, 1, 2, 3, 4];
  for (let i = twoLong.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [twoLong[i], twoLong[j]] = [twoLong[j], twoLong[i]];
  }
  const longSeats = new Set(twoLong.slice(0, 2));
  for (let i = 0; i < seats; i++) sizes.push(longSeats.has(i) ? 32 : 31);

  const hands = Array.from({ length: seats }, () => []);
  let at = 0;
  for (let i = 0; i < seats; i++) {
    hands[i] = deck.slice(at, at + sizes[i]);
    at += sizes[i];
  }
  let specialSeat = 0;
  for (let i = 0; i < seats; i++) {
    if (hands[i].some((c) => c.id === special.id)) { specialSeat = i; break; }
  }
  return { hands, sizes, specialCard: special, specialJokerId: special.id, specialSeat };
}

function countSix(hand) {
  return hand.reduce((n, c) => n + (c.rank === RANK_SIX ? 1 : 0), 0);
}

// 支付优先级：2(0) < 小王(1) < 普通大王(2) < 特殊大王(3)
function payPriority(card) {
  if (card.rank === RANK_TWO) return 0;
  if (card.rank === RANK_SMALL) return 1;
  if (card.rank === RANK_BIG) return card.special ? 3 : 2;
  return -1;
}

function choosePayment(hand) {
  let best = null;
  let bestP = Infinity;
  for (const c of hand) {
    const p = payPriority(c);
    if (p < 0) continue;
    if (p < bestP || (p === bestP && best && c.id < best.id)) {
      best = c;
      bestP = p;
    }
  }
  return best || null;
}

// 生成买6计划；任何买家没有支付牌时返回 null（调用方重新发牌）。
function planBuy6(hands) {
  const surplus = [];
  const buyers = [];
  hands.forEach((hand, seat) => {
    const n = countSix(hand);
    if (n === 0) buyers.push(seat);
    for (let k = 1; k < n; k++) surplus.push(seat);
  });
  if (buyers.length !== surplus.length) return null;

  const usedSix = new Set();
  const plan = [];
  let s = 0;
  for (const buyer of buyers.slice().sort((a, b) => a - b)) {
    const buyerHand = hands[buyer];
    const paid = choosePayment(buyerHand);
    if (!paid) return null;
    const seller = surplus[s++];
    const sixCard = hands[seller].find((c) => c.rank === RANK_SIX && !usedSix.has(c.id));
    if (!sixCard) return null;
    usedSix.add(sixCard.id);
    plan.push({ buyer, seller, paid, sixId: sixCard.id, sixCard });
  }
  return plan;
}

function applyBuy6(hands, plan) {
  for (const t of plan) {
    const bh = hands[t.buyer];
    const sh = hands[t.seller];
    const pi = bh.findIndex((c) => c.id === t.paid.id);
    if (pi >= 0) bh.splice(pi, 1);
    const si = sh.findIndex((c) => c.id === t.sixId);
    if (si >= 0) sh.splice(si, 1);
    bh.push(t.sixCard);
    sh.push(t.paid);
  }
}

// 是否可登基的三张：同花色、同点数、非6、非王；手中恰好 3 张。
// 2 可以被选作皇炸（皇炸牌不再当混儿使用）。
function findTriples(hand) {
  const groups = new Map();
  for (const c of hand) {
    if (c.rank < 7 || c.rank > 15) continue;
    const key = `${c.suit}-${c.rank}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const out = [];
  for (const [key, cards] of groups) {
    if (cards.length !== 3) continue;
    out.push({ key, suit: cards[0].suit, rank: cards[0].rank, cards });
  }
  out.sort((a, b) => b.rank - a.rank || a.suit - b.suit);
  return out;
}

// 找到第四张完全相同牌的持有者（侍卫）。
function findGuardHolder(hands, triple, emperorSeat) {
  const { suit, rank } = triple.cards[0];
  const ids = new Set(triple.cards.map((c) => c.id));
  for (let seat = 0; seat < hands.length; seat++) {
    if (seat === emperorSeat) continue;
    for (const c of hands[seat]) {
      if (c.suit === suit && c.rank === rank && !ids.has(c.id)) return { seat, cardId: c.id };
    }
  }
  return null;
}

function nextSeat(seat, seats = SEATS) {
  return (seat + 1) % seats;
}

function prevSeat(seat, seats = SEATS) {
  return (seat - 1 + seats) % seats;
}

module.exports = {
  SEATS,
  RANK_SIX,
  RANK_TWO,
  RANK_SMALL,
  RANK_BIG,
  buildDeck,
  shuffle,
  deal,
  countSix,
  payPriority,
  choosePayment,
  planBuy6,
  applyBuy6,
  findTriples,
  findGuardHolder,
  nextSeat,
  prevSeat,
};
