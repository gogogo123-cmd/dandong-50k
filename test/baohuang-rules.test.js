'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const cards = require('../src/baohuang/cards');
const rules = require('../src/baohuang/rules');

let seq = 0;
function c(rank, suit = 0) {
  return { id: `t${seq++}-${rank}-${suit}`, rank, suit };
}
function group(rank, n, suit = 0) {
  return Array.from({ length: n }, () => c(rank, suit));
}
const ctx = (emperorIds = [], guardId = null) => ({ emperorIds: new Set(emperorIds), guardId });
const analyze = (cs, cx = ctx()) => rules.analyze(cs, cx);

test('牌库 157 张且构成正确', () => {
  const deck = cards.buildDeck();
  assert.equal(deck.length, 157);
  const count = (rank) => deck.filter((x) => x.rank === rank).length;
  assert.equal(count(6), 5);
  for (let r = 7; r <= 15; r++) assert.equal(count(r), 16, `rank ${r}`);
  assert.equal(count(16), 4);
  assert.equal(count(17), 4);
});

test('发牌 32/32/31/31/31，且恰好一张特殊大王', () => {
  const d = cards.deal(5);
  assert.deepEqual([...d.sizes].sort(), [31, 31, 31, 32, 32]);
  const all = d.hands.flat();
  assert.equal(all.length, 157);
  assert.equal(new Set(all.map((x) => x.id)).size, 157);
  const specials = all.filter((x) => x.special);
  assert.equal(specials.length, 1);
  assert.equal(specials[0].rank, 17);
  assert.equal(d.specialJokerId, specials[0].id);
  assert.equal(d.specialSeat, d.hands.findIndex((h) => h.some((x) => x.special)));
});

test('买6：支付优先级 2 > 小王 > 大王 > 特殊大王；买完每人一张6', () => {
  const hands = [
    [c(6), c(6), c(15)], // 卖家，多余一张6
    [c(7), c(16)], // 买家，只能付小王
    [c(8), c(17, 4)], // 买家，普通大王
    [c(6), c(6), c(6)], // 卖家，多余两张6
    [c(9), c(15)], // 买家，付2
  ];
  hands[2][1].special = true; // 只有特殊大王可付
  const plan = cards.planBuy6(hands);
  assert.ok(plan);
  assert.equal(plan.length, 3);
  assert.equal(plan[0].paid.rank, 16);
  assert.equal(plan[1].paid.rank, 17);
  assert.equal(plan[1].paid.special, true);
  assert.equal(plan[2].paid.rank, 15);
  cards.applyBuy6(hands, plan);
  for (const h of hands) assert.equal(cards.countSix(h), 1);
});

test('买6优先用2支付；无任何支付牌则重新发牌', () => {
  const hands = [
    [c(6), c(6)],
    [c(9), c(10), c(15)], // 有2
    [c(8)], // 无支付牌
    [c(6), c(6)],
    [c(6)],
  ];
  const plan = cards.planBuy6(hands);
  assert.equal(plan, null, '有人无支付牌 → 返回 null');

  const fine = [
    [c(6), c(6)],
    [c(9), c(15)],
    [c(8), c(16)],
    [c(6), c(6)],
    [c(6)],
  ];
  const p2 = cards.planBuy6(fine);
  assert.ok(p2);
  assert.equal(p2[0].paid.rank, 15);
  assert.equal(p2[1].paid.rank, 16);
});

test('皇帝三张：同花色同点数恰好 3 张；6 和王不能登基', () => {
  const hand = [
    c(14, 1), c(14, 1), c(14, 1), // 三张♥A
    c(6), c(6), c(6), // 三张6
    c(16, 4), c(16, 4), c(16, 4), // 三张小王
  ];
  const triples = cards.findTriples(hand);
  assert.equal(triples.length, 1);
  assert.equal(triples[0].rank, 14);
  assert.equal(triples[0].suit, 1);

  const four = [c(14, 1), c(14, 1), c(14, 1), c(14, 1)];
  assert.equal(cards.findTriples(four).length, 0, '四张都在手中不能登基');
});

test('第四张完全相同牌为侍卫', () => {
  const triple = cards.findTriples([c(9, 2), c(9, 2), c(9, 2)])[0];
  const hands = [
    triple.cards,
    [c(9, 2), c(10, 0)],
    [c(7, 0)],
  ];
  const guard = cards.findGuardHolder(hands, triple, 0);
  assert.equal(guard.seat, 1);
  assert.equal(guard.cardId, hands[1][0].id);
});

test('普通牌型：不允许顺子/连对/三带', () => {
  assert.equal(analyze([c(7), c(8), c(9)]), null);
  assert.equal(analyze([c(7), c(7), c(8), c(8)]), null);
  assert.equal(analyze([c(9), c(9), c(9), c(10)]), null);
  assert.equal(analyze([c(9), c(9)]).kind, 'combo');
  assert.equal(analyze([c(9), c(9), c(9)]).kind, 'combo');
  assert.equal(analyze(group(9, 5).map((x, i) => c(9, i % 4))).kind, 'combo');
});

test('混儿组合：2 与王不能同组，纯混儿不能成组', () => {
  assert.equal(analyze([c(8), c(8), c(8), c(15)]).kind, 'combo');
  assert.equal(analyze([c(8), c(15), c(16)]), null, '2 和王不能同组');
  assert.equal(analyze([c(15), c(15)]), null, '纯2不能成组');
  assert.equal(analyze([c(16), c(16)]), null, '双王不能成对');
  const both = analyze([c(8), c(8), c(8), c(16), c(17)]);
  assert.equal(both.kind, 'combo', '小王和大王可以同时作混儿');
  assert.deepEqual(both.wilds, [2, 2]);
});

test('四张同花色炸弹不能用混儿补足', () => {
  const real = [c(10, 1), c(10, 1), c(10, 1), c(10, 1)];
  assert.equal(analyze(real).kind, 'suitBomb');
  const compensated = [c(10, 1), c(10, 1), c(10, 1), c(15)];
  const t = analyze(compensated);
  assert.equal(t.kind, 'combo', '混儿补出的四张只能算普通套牌，不是炸弹');
});

test('炸弹层级：同花4张 < 三小王 < 三大王 < 四小王 < 四大王 < 皇炸', () => {
  const suitBomb = analyze([c(14, 0), c(14, 0), c(14, 0), c(14, 0)]);
  const k3s = analyze([c(16, 4), c(16, 4), c(16, 4)]);
  const k3b = analyze([c(17, 4), c(17, 4), c(17, 4)]);
  const k4s = analyze([c(16, 4), c(16, 4), c(16, 4), c(16, 4)]);
  const k4b = analyze([c(17, 4), c(17, 4), c(17, 4), c(17, 4)]);
  const emp = [c(9, 2), c(9, 2), c(9, 2)];
  const empBomb = analyze(emp, ctx(emp.map((x) => x.id)));
  const levels = [suitBomb, k3s, k3b, k4s, k4b, empBomb].map((t) => t.bombLevel);
  assert.deepEqual(levels, [1, 2, 3, 4, 5, 6]);
  for (let i = 1; i < 6; i++) {
    assert.equal(rules.beats([suitBomb, k3s, k3b, k4s, k4b, empBomb][i], [suitBomb, k3s, k3b, k4s, k4b, empBomb][i - 1]), true);
  }
  assert.equal(rules.beats(k3s, analyze([c(16, 4), c(16, 4), c(16, 4)])), false, '同级不能互压');
});

test('同花炸弹同点不同花不能互压，不同点数按点数', () => {
  const a = analyze([c(10, 0), c(10, 0), c(10, 0), c(10, 0)]);
  const b = analyze([c(10, 1), c(10, 1), c(10, 1), c(10, 1)]);
  const k = analyze([c(11, 0), c(11, 0), c(11, 0), c(11, 0)]);
  assert.equal(rules.beats(a, b), false);
  assert.equal(rules.beats(b, a), false);
  assert.equal(rules.beats(k, a), true);
});

test('混儿比较：PRD 示例逐条校验', () => {
  const up8882 = analyze([c(8), c(8), c(8), c(15)]);
  const down9992 = analyze([c(9), c(9), c(9), c(15)]);
  const d99_22 = analyze([c(9), c(9), c(15), c(15)]);
  const d999Small = analyze([c(9), c(9), c(9), c(16)]);
  const d999Big = analyze([c(9), c(9), c(9), c(17)]);
  assert.equal(rules.beats(down9992, up8882), true);
  assert.equal(rules.beats(d99_22, up8882), true);
  assert.equal(rules.beats(d999Small, up8882), true);
  assert.equal(rules.beats(d999Big, up8882), true);

  const up888Big = analyze([c(8), c(8), c(8), c(17)]);
  assert.equal(rules.beats(down9992, up888Big), false, '下家混儿2 < 上家大王');

  const up88Big = analyze([c(8), c(8), c(17)]);
  const d99SmallPair = analyze([c(9), c(9), c(16)]);
  const d99_2 = analyze([c(9), c(9), c(15)]);
  const d99_22_3 = analyze([c(9), c(9), c(15), c(15)]);
  assert.equal(rules.beats(d99SmallPair, up88Big), true);
  assert.equal(rules.beats(d99_2, up88Big), false);
  assert.equal(rules.beats(d99_22_3, up88Big), false, '总张数不同');
  const d999_22 = analyze([c(9), c(9), c(9), c(15), c(15)]);
  assert.equal(rules.beats(d999_22, up8882), false, '总张数不同不能管');
});

test('皇炸单张/对子：炸弹可压，普通牌不可压；皇炸单张与侍卫牌相等', () => {
  const empCards = [c(9, 2), c(9, 2), c(9, 2)];
  const guardCard = { id: 'guard-x', rank: 13, suit: 2 };
  const ectx = ctx(empCards.map((x) => x.id), guardCard.id);
  const empSingle = rules.analyze([empCards[0]], ectx);
  const empPair = rules.analyze([empCards[0], empCards[1]], ectx);
  const bigSingle = rules.analyze([c(17, 4)], ectx);
  const guardSingle = rules.analyze([guardCard], ectx);
  assert.equal(rules.beats(empSingle, bigSingle), true);
  assert.equal(rules.beats(bigSingle, empSingle), false);
  assert.equal(rules.beats(empSingle, guardSingle), false);
  assert.equal(rules.beats(guardSingle, empSingle), false);
  const bomb = rules.analyze([c(10, 3), c(10, 3), c(10, 3), c(10, 3)]);
  assert.equal(rules.beats(bomb, empSingle), true);
  assert.equal(rules.beats(bomb, guardSingle), true);
  const pair = rules.analyze([c(14), c(14)]);
  assert.equal(rules.beats(pair, empPair), false);
  assert.equal(rules.beats(empPair, pair), true);
});

test('侍卫牌只能单张，炸弹可压，普通单张不能压', () => {
  const guardCard = { id: 'guard-x', rank: 12, suit: 3 };
  const cx = ctx([], guardCard.id);
  const single = rules.analyze([guardCard], cx);
  assert.equal(single.role, 'guard');
  assert.equal(rules.analyze([guardCard, c(12, 3)], cx), null);
  assert.equal(rules.beats(single, rules.analyze([c(17, 4)], cx)), true);
  assert.equal(rules.beats(rules.analyze([c(17, 4)], cx), single), false);
  const bomb = rules.analyze([c(8, 0), c(8, 0), c(8, 0), c(8, 0)]);
  assert.equal(rules.beats(bomb, single), true);
});

test('6 不能被任何牌压制，且只能最后一张出', () => {
  const six = rules.analyze([c(6)]);
  assert.equal(six.kind, 'six');
  const bomb = rules.analyze([c(8, 0), c(8, 0), c(8, 0), c(8, 0)]);
  assert.equal(rules.beats(bomb, six), false);
  assert.equal(rules.beats(six, bomb), false);

  const hand = [c(6), c(7)];
  assert.equal(rules.checkPlay([hand[1]], hand, ctx()).ok, true);
  const early = rules.checkPlay([hand[0]], hand, ctx());
  assert.equal(early.ok, false);
  const lastHand = [c(6)];
  assert.equal(rules.checkPlay([lastHand[0]], lastHand, ctx()).ok, true);
});

test('单张大小：大王 > 小王 > 2 > A > ... > 7', () => {
  const order = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
  for (let i = 1; i < order.length; i++) {
    const hi = rules.analyze([c(order[i])]);
    const lo = rules.analyze([c(order[i - 1])]);
    assert.equal(rules.beats(hi, lo), true, `${order[i]} > ${order[i - 1]}`);
  }
});
