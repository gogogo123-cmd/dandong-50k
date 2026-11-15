'use strict';
// 保皇牌型与比较规则。
// 牌型：单张、对子、三张、4+ 张同点数普通套牌（含混儿组合）、同花炸弹、王炸、皇炸。
// 混儿组合按“普通牌部分 + 混儿部分”分别比较。

const RANK_SIX = 6;
const RANK_TWO = 15;
const RANK_SMALL = 16;
const RANK_BIG = 17;
const TOP_POWER = 1000;

const RANK_LABEL = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' };
const SUIT_LABEL = { 0: '♠', 1: '♥', 2: '♣', 3: '♦' };

function rankLabel(rank) {
  return RANK_LABEL[rank] || String(rank);
}

function wildPower(rank) {
  return rank === RANK_TWO ? 1 : 2; // 小王 = 大王 > 2
}

function isWildRank(rank) {
  return rank === RANK_TWO || rank === RANK_SMALL || rank === RANK_BIG;
}

// ctx: { emperorIds:Set<string>, guardId:string|null }
function analyze(cards, ctx = {}) {
  const n = cards.length;
  if (!n) return null;
  const emperorIds = ctx.emperorIds || new Set();
  const guardId = ctx.guardId || null;

  const emperorCards = cards.filter((c) => emperorIds.has(c.id));
  const guardCard = cards.find((c) => c.id === guardId) || null;
  const sixes = cards.filter((c) => c.rank === RANK_SIX);

  // 6 只能单独打出
  if (sixes.length) {
    if (n !== 1) return null;
    return { kind: 'six', n: 1, power: 0 };
  }
  // 侍卫牌只能作为单张
  if (guardCard) {
    if (n !== 1) return null;
    return { kind: 'single', n: 1, power: TOP_POWER, role: 'guard' };
  }
  // 皇炸牌不能与其他牌混组
  if (emperorCards.length && emperorCards.length !== n) return null;

  if (n === 1) {
    const c = cards[0];
    if (emperorCards.length) return { kind: 'single', n: 1, power: TOP_POWER, role: 'emperor', rank: c.rank };
    return { kind: 'single', n: 1, power: c.rank, rank: c.rank, wild: isWildRank(c.rank) };
  }

  if (emperorCards.length) {
    if (n === 2) return { kind: 'emperorPair', n: 2, power: TOP_POWER };
    if (n === 3) return { kind: 'emperorBomb', n: 3, power: TOP_POWER, bombLevel: 6 };
    return null;
  }

  const ranks = cards.map((c) => c.rank);
  const suits = cards.map((c) => c.suit);

  // 王炸：三小王 / 三大王 / 四小王 / 四大王
  if (ranks.every((r) => r >= RANK_SMALL) && ranks.every((r) => r === ranks[0]) && n >= 3) {
    const rank = ranks[0];
    const level = rank === RANK_SMALL ? (n === 3 ? 2 : n === 4 ? 4 : 0) : (n === 3 ? 3 : n === 4 ? 5 : 0);
    if (!level) return null;
    return { kind: 'jokerBomb', n, rank, power: rank, bombLevel: level };
  }

  // 双王对：两张相同王可成对（小王对压所有普通对子，大王对压普通对子和小王对）；小王+大王不成组
  if (n === 2 && ranks[0] >= RANK_SMALL && ranks[0] === ranks[1]) {
    return { kind: 'jokerPair', n: 2, rank: ranks[0], power: ranks[0] };
  }

  // 四张同花色、同点数炸弹（7~2，四张真实牌）
  if (n === 4 && suits.every((s) => s === suits[0]) && ranks.every((r) => r === ranks[0])
    && ranks[0] >= 7 && ranks[0] <= RANK_TWO) {
    return { kind: 'suitBomb', n: 4, rank: ranks[0], power: ranks[0], bombLevel: 1 };
  }

  // 普通牌 + 混儿组合。2 兼具普通牌（最大普通点数）与混儿两种身份：
  // - 与其他普通点数同组时，2 作为混儿；
  // - 没有其他普通点数时，2 作为普通牌成组（对/三/四张2），王仍可作混儿。
  const normals = [];
  const twos = [];
  const kings = [];
  for (const c of cards) {
    if (c.rank >= 7 && c.rank <= 14) normals.push(c.rank);
    else if (c.rank === RANK_TWO) twos.push(c.rank);
    else if (c.rank >= RANK_SMALL) kings.push(c.rank);
    else return null;
  }
  let wilds;
  if (normals.length) {
    if (twos.length && kings.length) return null; // 2 和王不能同为混儿
    wilds = twos.concat(kings);
  } else if (twos.length) {
    normals.push(...twos); // 纯2组按普通牌 2（最大普通点数）处理
    wilds = kings;
  } else {
    return null; // 纯王不能成组（王炸/皇炸已单独处理）
  }
  if (!normals.every((r) => r === normals[0])) return null;

  normals.sort((a, b) => b - a);
  const wp = wilds.map(wildPower).sort((a, b) => b - a);
  return {
    kind: 'combo',
    n,
    normals,
    wilds: wp,
    normalRank: normals[0],
    wildFamily: wp.length ? (wilds[0] === RANK_TWO ? 'two' : 'king') : null,
    power: normals[0],
  };
}

function isBomb(type) {
  return !!type && (type.kind === 'suitBomb' || type.kind === 'jokerBomb' || type.kind === 'emperorBomb');
}

function comboBeats(a, b) {
  if (a.n !== b.n) return false;
  const na = a.normals || [];
  const nb = b.normals || [];
  if (!na.length || !nb.length) return false;
  const ln = Math.min(na.length, nb.length);
  for (let i = 0; i < ln; i++) {
    if (!(na[i] > nb[i])) return false; // 普通牌逐张严格大于
  }
  const wa = a.wilds || [];
  const wb = b.wilds || [];
  const lw = Math.min(wa.length, wb.length);
  for (let i = 0; i < lw; i++) {
    if (!(wa[i] >= wb[i])) return false; // 混儿逐张大于等于
  }
  return true;
}

// a 能否压过 b；b 为空表示领出。
function beats(a, b) {
  if (!a) return false;
  if (!b) return true;
  if (b.kind === 'six') return false; // 6 不能被任何牌压制
  if (a.kind === 'six') return false; // 6 也不压别的牌

  const ab = isBomb(a);
  const bb = isBomb(b);
  if (ab && bb) {
    if (a.bombLevel !== b.bombLevel) return a.bombLevel > b.bombLevel;
    if (a.kind === 'suitBomb') return a.rank > b.rank; // 同等级同点不同花不能互压
    return false; // 王炸/皇炸同级不能互压
  }
  if (ab) return true; // 炸弹可压任意普通牌、侍卫牌、皇炸单/对
  if (bb) return false;

  if (a.kind === 'single') {
    if (b.kind !== 'single') return false;
    return a.power > b.power;
  }

  if (a.kind === 'jokerPair') {
    if (b.kind === 'combo') return b.n === 2; // 双王对压所有普通对子
    if (b.kind === 'jokerPair') return a.rank > b.rank; // 大王对压小王对
    return false;
  }

  if (a.kind === 'emperorPair') {
    // 皇炸对子是全场最大对子：可压普通对子与双王对，同级不能互压
    return (b.kind === 'combo' && b.n === 2) || b.kind === 'jokerPair';
  }

  if (a.kind === 'combo') {
    if (b.kind !== 'combo') return false;
    return comboBeats(a, b);
  }

  return false;
}

function cardLabel(card) {
  if (card.rank >= RANK_SMALL) return rankLabel(card.rank);
  if (card.rank === RANK_SIX) return '6';
  return `${SUIT_LABEL[card.suit] || ''}${rankLabel(card.rank)}`;
}

function describeType(type) {
  if (!type) return '不成牌型';
  switch (type.kind) {
    case 'six': return '6';
    case 'single':
      if (type.role === 'emperor') return '皇炸单张';
      if (type.role === 'guard') return '侍卫牌';
      return `${rankLabel(type.rank)}单张`;
    case 'emperorPair': return '皇炸对子';
    case 'jokerPair': return `两张${type.rank === RANK_SMALL ? '小王' : '大王'}`;
    case 'emperorBomb': return '皇炸三张';
    case 'suitBomb': return `${rankLabel(type.rank)}同花炸弹`;
    case 'jokerBomb': return `${type.n}张${type.rank === RANK_SMALL ? '小王' : '大王'}炸弹`;
    case 'combo': {
      const normal = `${rankLabel(type.normalRank)}×${type.normals.length}`;
      if (!type.wilds.length) return normal;
      const fam = type.wildFamily === 'two' ? '2' : '王';
      return `${normal} + 混儿${fam}×${type.wilds.length}`;
    }
    default: return '不成牌型';
  }
}

// 校验一手牌的合法性（含 6 必须最后一张）。
function checkPlay(cards, hand, ctx) {
  if (!cards || !cards.length) return { ok: false, error: '请选择手牌' };
  if (new Set(cards.map((c) => c.id)).size !== cards.length) return { ok: false, error: '不能重复选择同一张牌' };
  const type = analyze(cards, ctx);
  if (!type) return { ok: false, error: '当前牌型不合法' };
  if (cards.some((c) => c.rank === RANK_SIX)) {
    if (cards.length !== 1 || hand.length !== 1) return { ok: false, error: '当前不能打出6，6必须作为最后一张牌' };
  }
  if (cards.some((c) => c.id === ctx.guardId) && cards.length !== 1) {
    return { ok: false, error: '侍卫牌只能作为单张打出' };
  }
  return { ok: true, type };
}

module.exports = {
  RANK_SIX,
  RANK_TWO,
  RANK_SMALL,
  RANK_BIG,
  TOP_POWER,
  rankLabel,
  wildPower,
  isWildRank,
  analyze,
  beats,
  isBomb,
  comboBeats,
  cardLabel,
  describeType,
  checkPlay,
};
