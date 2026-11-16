'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { classify, beats, trump, passTurn, awardTrick, finishCard } = require('../src/rules');

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

test('双炸弹：两个炸弹一起出，须两个炸弹分别压住；单炸弹不能管', () => {
  const bomb = (rank, n = 3) => Array.from({ length: n }, (_, i) => ({ id: `b${rank}-${i}`, rank, suit: i % 4 }));
  const lead = classify([...bomb(8), ...bomb(9)]);
  assert.equal(lead.kind, 'doubleBomb');
  assert.deepEqual(lead.bombs, [{ n: 3, power: 8 }, { n: 3, power: 9 }]);

  assert.equal(beats(classify(bomb(10)), lead), false, '一个炸弹不能管双炸弹');
  assert.equal(beats(classify([...bomb(10), ...bomb(11)]), lead), true, '两个更大炸弹分别压住');
  assert.equal(beats(classify([...bomb(10), ...bomb(7)]), lead), false, '一大一小无法分别压住');
  assert.equal(beats(classify([...bomb(9), ...bomb(10)]), lead), true, '同点数炸弹按升级压');

  const six = classify(bomb(12, 6));
  assert.equal(six.kind, 'bomb');
  assert.equal(beats(six, lead), true, '6张炸弹拆成3+3可管');
  assert.equal(beats(classify(bomb(12, 5)), lead), false, '5张炸弹不能拆成两个炸弹');
  assert.equal(beats(classify(bomb(8, 6)), lead), false, '拆出的3张8压不过3张8');

  const mixed = classify([
    { id: 'm5', rank: 5, suit: 0 }, { id: 'm10', rank: 10, suit: 1 }, { id: 'm13', rank: 13, suit: 2 },
  ]);
  assert.equal(beats(mixed, lead), true, '一条腿可管双炸弹');
  const king2 = classify([
    { id: 'k2a', rank: 16, suit: 4 }, { id: 'k2b', rank: 16, suit: 4 },
  ]);
  assert.equal(beats(king2, lead), true, '双王可管双炸弹');
  const king3 = classify([
    { id: 'k3a', rank: 17, suit: 4 }, { id: 'k3b', rank: 17, suit: 4 }, { id: 'k3c', rank: 17, suit: 4 },
  ]);
  assert.equal(beats(king3, lead), true, '三王可管双炸弹');

  assert.equal(beats(classify([...bomb(10), ...bomb(11)]), classify(bomb(10))), false, '双炸弹不能压单炸弹');
  assert.equal(beats(classify([...bomb(10), ...bomb(11)]), king2), false, '双炸弹不能压双王');
});

test('双炸弹：两副不同张数炸弹按张数/点数分别比较；王不属于炸弹组件', () => {
  const bomb = (rank, n) => Array.from({ length: n }, (_, i) => ({ id: `c${rank}-${i}`, rank, suit: i % 4 }));
  const lead = classify([...bomb(6, 4), ...bomb(12, 3)]);
  assert.equal(lead.kind, 'doubleBomb');
  const attack = classify([...bomb(7, 4), ...bomb(13, 4)]);
  assert.equal(beats(attack, lead), true, '4张7压3张Q、4张K压4张6，可分别配对');
  const bad = classify([...bomb(7, 3), ...bomb(13, 4)]);
  assert.equal(beats(bad, lead), false, '3张7压不过3张Q，无法完成配对');
  const seven = classify(bomb(13, 7));
  assert.equal(beats(seven, lead), true, '7张K炸弹拆3+4，可分别压住两副炸弹');
  const sixLow = classify(bomb(5, 6));
  assert.equal(beats(sixLow, lead), false, '6张5炸弹拆出的3张压不过3张Q');
  assert.equal(classify([...bomb(16, 4), ...bomb(8, 3)]), null, '王/腿不作为双炸弹组件');
});
