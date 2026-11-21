'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classify, beats, trump, passTurn, awardTrick, finishCard, regroupTeams } = require('../src/rules');

function baseRoom() {
  const players = Array.from({ length: 6 }, (_, i) => ({
    name: `P${i}`,
    hand: [{ id: `c${i}`, rank: 5, suit: 0 }],
    done: false,
  }));
  return {
    players,
    teams: [0, 1, 0, 1, 0, 1],
    positions: [0, 1, 2, 3, 4, 5],
    scores: [0, 0],
    trickPoints: 5,
    log: [],
    passed: Array(6).fill(false),
    lead: {
      seat: 0,
      kind: 'single',
      n: 1,
      power: 5,
      cards: [{ id: 'lead', rank: 5, suit: 0 }],
      responders: 5,
    },
    passes: 0,
    playedBy: Array(6).fill([{ id: 'x', rank: 5, suit: 0 }]),
    turn: 1,
    finished: false,
  };
}

test('接风：leader finished, next active teammate leads', () => {
  const r = baseRoom();
  r.players[0].done = true;
  r.players[0].hand = [];
  r.players[2].done = true;
  r.players[2].hand = [];
  r.lead.responders = 4; // active responders: 1, 3, 4, 5

  for (const seat of [1, 3, 4, 5]) passTurn(r, seat, r.players[seat].name);

  assert.equal(r.turn, 4, 'seat 4 is the next active teammate');
  assert.ok(r.log.some((x) => x.includes('接风')));
  assert.deepEqual(r.passed, Array(6).fill(false));
  assert.equal(r.lead, null);
  assert.deepEqual(r.scores, [5, 0]);
});

test('接风：no active teammate falls back to normal order', () => {
  const r = baseRoom();
  for (const seat of [0, 2, 4]) {
    r.players[seat].done = true;
    r.players[seat].hand = [];
  }
  r.lead.responders = 3; // active responders: 1, 3, 5

  for (const seat of [1, 3, 5]) passTurn(r, seat, r.players[seat].name);

  assert.equal(r.turn, 1, 'normal order from the leader');
  assert.ok(!r.log.some((x) => x.includes('接风')));
});

test('pure leg beats mixed leg', () => {
  const pure = [
    { id: 'p5', rank: 5, suit: 1 },
    { id: 'p10', rank: 10, suit: 1 },
    { id: 'p13', rank: 13, suit: 1 },
  ];
  const mixed = [
    { id: 'm5', rank: 5, suit: 0 },
    { id: 'm10', rank: 10, suit: 1 },
    { id: 'm13', rank: 13, suit: 2 },
  ];
  const a = classify(pure);
  const b = classify(mixed);
  assert.equal(a.kind, 'pureLeg');
  assert.equal(b.kind, 'mixedLeg');
  assert.ok(trump('pureLeg') > trump('mixedLeg'));
  assert.equal(beats(a, b), true);
  assert.equal(beats(b, a), false);
});

test('pass marks the seat; award and play reset marks', () => {
  const r = baseRoom();
  passTurn(r, 1, 'P1');
  assert.equal(r.passed[1], true);

  r.passed[3] = true;
  r.players[3].hand = [{ id: 'a3', rank: 6, suit: 0 }];
  finishCard(r, 3, [r.players[3].hand[0]]);
  assert.equal(r.passed[3], false);

  r.passed[2] = true;
  awardTrick(r);
  assert.deepEqual(r.passed, Array(6).fill(false));
});


test('连对：单炸弹不能管，需两副炸弹齐出/6张以上炸弹/腿/双王', () => {
  const bomb = (rank, n = 3) => Array.from({ length: n }, (_, i) => ({ id: `b${rank}-${i}`, rank, suit: i % 4 }));
  const pairs = (rank) => [
    { id: `p${rank}a`, rank, suit: 0 }, { id: `p${rank}b`, rank, suit: 1 },
  ];
  const lead = classify([...pairs(7), ...pairs(8), ...pairs(9)]); // 778899
  assert.equal(lead.kind, 'doubleStraight');
  assert.equal(lead.n, 6);

  assert.equal(beats(classify(bomb(10)), lead), false, '一个炸弹不能管连对');
  assert.equal(beats(classify(bomb(10, 5)), lead), false, '5张炸弹不能管连对');
  assert.equal(beats(classify(bomb(10, 6)), lead), true, '6张炸弹可拆成两副炸弹管连对');
  assert.equal(beats(classify([...bomb(10), ...bomb(11)]), lead), true, '两副炸弹齐出可管连对');
  assert.equal(beats(classify([...bomb(6), ...bomb(7)]), lead), true, '两副炸弹不看点数即可管连对');

  const higher = classify([...pairs(9), ...pairs(10), ...pairs(11)]);
  assert.equal(beats(higher, lead), true, '更大的同长连对可以管');
  const longer = classify([...pairs(9), ...pairs(10), ...pairs(11), ...pairs(12)]);
  assert.equal(beats(longer, lead), false, '连对张数不同不能互管');

  const mixed = classify([
    { id: 'm5', rank: 5, suit: 0 }, { id: 'm10', rank: 10, suit: 1 }, { id: 'm13', rank: 13, suit: 2 },
  ]);
  assert.equal(beats(mixed, lead), true, '一条腿可管连对');
  const king2 = classify([
    { id: 'k2a', rank: 16, suit: 4 }, { id: 'k2b', rank: 16, suit: 4 },
  ]);
  assert.equal(beats(king2, lead), true, '双王可管连对');
  const king3 = classify([
    { id: 'k3a', rank: 17, suit: 4 }, { id: 'k3b', rank: 17, suit: 4 }, { id: 'k3c', rank: 17, suit: 4 },
  ]);
  assert.equal(beats(king3, lead), true, '三王可管连对');

  const twoBombs = classify([...bomb(10), ...bomb(11)]);
  assert.equal(twoBombs.kind, 'doubleBomb');
  assert.equal(beats(twoBombs, classify(bomb(10))), false, '双炸弹不能管单炸弹');
  assert.equal(beats(twoBombs, king2), false, '双炸弹不能管双王');
  assert.equal(beats(lead, twoBombs), false, '连对不能管双炸弹');

  const biggerBombs = classify([...bomb(12), ...bomb(13)]);
  assert.equal(beats(biggerBombs, twoBombs), true, '更大的双炸弹可以管双炸弹');
  assert.equal(beats(twoBombs, biggerBombs), false, '较小的双炸弹不能管更大的双炸弹');
  assert.equal(beats(classify(bomb(12, 6)), twoBombs), false, '单炸弹不能管双炸弹');
  assert.equal(beats(mixed, twoBombs), true, '杂五十K可以管双炸弹');
  const pure = classify([
    { id: 'q5', rank: 5, suit: 2 }, { id: 'q10', rank: 10, suit: 2 }, { id: 'q13', rank: 13, suit: 2 },
  ]);
  assert.equal(pure.kind, 'pureLeg');
  assert.equal(beats(pure, twoBombs), true, '纯五十K可以管双炸弹');
  assert.equal(beats(king2, twoBombs), true, '双王可以管双炸弹');
  assert.equal(beats(king3, twoBombs), true, '三王可以管双炸弹');

  const eightNine = classify([...bomb(8), ...bomb(9)]);
  const jackQueen = classify([...bomb(11), ...bomb(12)]);
  assert.equal(eightNine.kind, 'doubleBomb');
  assert.equal(jackQueen.kind, 'doubleBomb');
  assert.equal(beats(jackQueen, eightNine), true, 'JJJQQQ 可以管 888999');
  assert.equal(beats(eightNine, jackQueen), false, '888999 不能管 JJJQQQ');
});

test('出牌区按点数排序：连对记录为 77 88 99', () => {
  const r = baseRoom();
  const cards = [
    { id: 'x7s', rank: 7, suit: 0 }, { id: 'x9s', rank: 9, suit: 0 }, { id: 'x8s', rank: 8, suit: 0 },
    { id: 'x7h', rank: 7, suit: 1 }, { id: 'x9h', rank: 9, suit: 1 }, { id: 'x8h', rank: 8, suit: 1 },
  ];
  r.players[1].hand = cards.slice();
  finishCard(r, 1, cards);
  assert.deepEqual(r.playedBy[1].map((c) => c.rank), [7, 7, 8, 8, 9, 9]);
  assert.deepEqual(r.lead.cards.map((c) => c.rank), [7, 7, 8, 8, 9, 9]);
});

test('双炸弹：王/腿不作为组件；连对本身不会被识别成双炸弹', () => {
  const bomb = (rank, n = 3) => Array.from({ length: n }, (_, i) => ({ id: `c${rank}-${i}`, rank, suit: i % 4 }));
  assert.equal(classify([...bomb(16, 4), ...bomb(8, 3)]), null, '王不作为双炸弹组件');
  const pairs = (rank) => [
    { id: `q${rank}a`, rank, suit: 0 }, { id: `q${rank}b`, rank, suit: 1 },
  ];
  assert.equal(classify([...pairs(6), ...pairs(7), ...pairs(8), ...pairs(9)]).kind, 'doubleStraight');
});

test('随机分组：同队玩家不相邻且红蓝各 3 人', () => {
  for (let round = 0; round < 50; round++) {
    const r = { players: Array(6).fill(null), teams: [], positions: [], log: [] };
    regroupTeams(r);
    assert.equal(r.teams.filter((t) => t === 0).length, 3);
    assert.equal(r.teams.filter((t) => t === 1).length, 3);
    for (let i = 0; i < 6; i++) {
      assert.notEqual(r.teams[i], r.teams[(i + 1) % 6], `第 ${round} 次分组：${i} 与 ${(i + 1) % 6} 号位同队`);
    }
  }
});
