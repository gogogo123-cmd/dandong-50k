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
