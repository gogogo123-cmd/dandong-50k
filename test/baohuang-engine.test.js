'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const bh = require('../src/baohuang/engine');

let seq = 0;
function c(rank, suit = 0) {
  return { id: `e${seq++}-${rank}-${suit}`, rank, suit };
}

function makeRoom(hands, extra = {}) {
  return Object.assign({
    id: 'ABC123',
    game: 'baohuang',
    numSeats: 5,
    started: true,
    finished: false,
    closed: false,
    phase: 'emperor',
    turn: 0,
    lead: null,
    passes: 0,
    passed: Array(5).fill(false),
    playedBy: Array(5).fill(null),
    candidateSeat: 0,
    initialCandidateSeat: 0,
    transferCount: 0,
    redealCount: 0,
    specialJokerId: null,
    specialSeat: null,
    emperorSeat: null,
    emperorTripleIds: [],
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
    gamesPlayed: 0,
    log: [],
    version: 1,
    turnDeadline: null,
    hostSeat: 0,
    players: hands.map((hand, i) => ({
      name: `P${i}`, hand, bot: false, done: false, ready: true, rank: null,
    })),
  }, extra);
}

function action(r, seat, name, payload = {}) {
  return bh.applyAction(r, seat, name, payload);
}

test('登基：三张同花色同点数，第四张持有者为暗侍卫', () => {
  const triple = [c(14, 1), c(14, 1), c(14, 1)];
  const guardCard = c(14, 1);
  const r = makeRoom([
    [...triple, c(7, 0), c(6)],
    [guardCard, c(8, 0), c(6)],
    [c(9), c(6)],
    [c(10), c(6)],
    [c(11), c(6)],
  ]);
  action(r, 0, 'emperor', { cards: triple.map((x) => x.id) });
  assert.equal(r.emperorSeat, 0);
  assert.equal(r.guardSeat, 1);
  assert.equal(r.guardCardId, guardCard.id);
  assert.equal(r.guardPublic, false);
  assert.equal(r.phase, 'playing');
  assert.equal(r.turn, 0);

  const emperorView = bh.publicState(r, 0, {});
  assert.equal(emperorView.players[1].guard, false);
  assert.equal(emperorView.players[1].role, null);
  assert.equal(emperorView.guardSeat, null);
  assert.equal(emperorView.players[0].role, 'emperor');

  const guardView = bh.publicState(r, 1, {});
  assert.equal(guardView.yourRole, 'guard');
  assert.equal(guardView.guardSeat, 1);
  assert.equal(guardView.players[1].guard, true);
  assert.equal(guardView.guardCardId, guardCard.id);

  const otherView = bh.publicState(r, 2, {});
  assert.equal(otherView.guardSeat, null);
  assert.equal(otherView.players[1].role, null);
  assert.equal(otherView.yourRole, 'revolution');
});

test('有合法三张必须登基，不能主动让位', () => {
  const triple = [c(9, 2), c(9, 2), c(9, 2)];
  const r = makeRoom([
    [...triple, c(6)],
    [c(9, 2), c(6)],
    [c(7), c(6)],
    [c(8), c(6)],
    [c(10), c(6)],
  ]);
  assert.throws(() => action(r, 0, 'emperor', { yield: true }), (e) => e.code === 'must-enthrone');
});

test('让位：首次不贡2，之后每次上贡一张2', () => {
  const two = c(15, 0);
  const r = makeRoom([
    [c(7), c(6)],
    [c(8), c(6)],
    [c(9), c(6)],
    [c(10), c(6)],
    [c(11), c(6), two],
  ]);
  action(r, 0, 'emperor', { yield: true });
  assert.equal(r.candidateSeat, 4);
  assert.equal(r.transferCount, 1);
  assert.equal(r.players[4].hand.some((x) => x.id === two.id), true, '首次让位不上贡');
  action(r, 4, 'emperor', { yield: true });
  assert.equal(r.candidateSeat, 3);
  assert.equal(r.transferCount, 2);
  assert.equal(r.players[4].hand.some((x) => x.id === two.id), false, '第二次让位交出2');
  assert.equal(r.players[3].hand.some((x) => x.id === two.id), true);
});

test('让位无2 → 本局重新发牌', () => {
  const r = makeRoom([
    [c(7), c(6)],
    [c(8), c(6)],
    [c(9), c(6)],
    [c(10), c(6)],
    [c(11), c(6)],
  ]);
  action(r, 0, 'emperor', { yield: true }); // 首次不贡
  action(r, 4, 'emperor', { yield: true }); // 第二次无2 → 重发
  assert.ok(r.redealCount >= 1);
  assert.equal(r.phase, 'emperor');
  const all = r.players.flatMap((p) => p.hand);
  assert.equal(all.length, 157);
  for (const p of r.players) assert.equal(p.hand.filter((x) => x.rank === 6).length, 1);
});

test('侍卫牌：只能单张，打出后身份公开', () => {
  const guardCard = c(13, 3);
  const r = makeRoom([
    [c(7), c(6)],
    [guardCard, c(8), c(6)],
    [c(9), c(6)],
    [c(10), c(6)],
    [c(11), c(6)],
  ], {
    phase: 'playing',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: guardCard.id,
    turn: 1,
  });
  assert.throws(() => action(r, 1, 'play', { cards: [guardCard.id, r.players[1].hand[1].id] }), (e) => e.code === 'bad-cards');
  action(r, 1, 'play', { cards: [guardCard.id] });
  assert.equal(r.guardPublic, true);
  assert.equal(r.players[1].done, false);
  const view = bh.publicState(r, 2, {});
  assert.equal(view.guardSeat, 1);
  assert.equal(view.players[1].role, 'guard');
});

test('6 必须最后一张；出完触发给风，可给任意仍有手牌玩家', () => {
  const six = c(6);
  const r = makeRoom([
    [six],
    [c(8), c(6)],
    [c(9), c(6)],
    [c(10), c(6)],
    [c(11), c(6)],
  ], { phase: 'playing', emperorSeat: 0, guardSeat: 1, guardCardId: 'nope', turn: 0 });
  action(r, 0, 'play', { cards: [six.id] });
  assert.equal(r.phase, 'wind');
  assert.equal(r.windGiverSeat, 0);
  assert.deepEqual(bh.publicState(r, 0, {}).windOptions, [1, 2, 3, 4]);
  // 给风不做阵营校验：皇帝给革命党也能继续
  action(r, 0, 'wind', { seat: 2 });
  assert.equal(r.phase, 'playing');
  assert.equal(r.turn, 2);
  assert.equal(r.lead, null);
  assert.equal(r.lastWind.giver, 0);
  assert.equal(r.lastWind.seat, 2);
});

test('革命党三人全部出完 → 革命党胜，未出完不参与判定', () => {
  const six = c(6);
  const r = makeRoom([
    [six],
    [c(8), c(6)],
    [],
    [],
    [],
  ], {
    phase: 'playing',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: 'nope',
    turn: 0,
    rankings: [2, 3, 4],
  });
  r.players[2].done = true; r.players[2].rank = 1;
  r.players[3].done = true; r.players[3].rank = 2;
  r.players[4].done = true; r.players[4].rank = 3;
  action(r, 0, 'play', { cards: [six.id] });
  assert.equal(r.finished, true);
  assert.equal(r.phase, 'settlement');
  assert.equal(r.winnerCamp, 'revolution');
  assert.equal(r.guardPublic, true);
  const view = bh.publicState(r, 2, {});
  assert.equal(view.guardSeat, 1);
  assert.equal(view.players[0].role, 'emperor');
  assert.equal(view.players[1].role, 'guard');
});

test('皇帝阵营一人头科、另一人进前三 → 皇帝阵营胜', () => {
  const six = c(6);
  const r = makeRoom([
    [],
    [],
    [six],
    [c(9), c(6)],
    [c(10), c(6)],
  ], {
    phase: 'playing',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: 'nope',
    turn: 2,
    rankings: [0, 2, 1],
  });
  r.players[0].done = true; r.players[0].rank = 1;
  r.players[1].done = true; r.players[1].rank = 3;
  action(r, 2, 'play', { cards: [six.id] });
  assert.equal(r.finished, true);
  assert.equal(r.winnerCamp, 'emperor');
  assert.equal(r.emperorWin, true);
});

test('皇帝阵营头科但另一人第四 → 革命党胜', () => {
  const six = c(6);
  const r = makeRoom([
    [],
    [],
    [six],
    [c(9), c(6)],
    [c(10), c(6)],
  ], {
    phase: 'playing',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: 'nope',
    turn: 2,
    rankings: [0, 2, 3, 1],
  });
  r.players[0].done = true; r.players[0].rank = 1;
  r.players[1].done = true; r.players[1].rank = 4;
  action(r, 2, 'play', { cards: [six.id] });
  assert.equal(r.winnerCamp, 'revolution');
  assert.equal(r.emperorWin, false);
});

test('最后一张6跟牌时允许直接打出并触发给风', () => {
  const leadCard = c(10, 0);
  const six = c(6);
  const r = makeRoom([
    [c(7), c(6)],
    [six],
    [c(9), c(6)],
    [c(11), c(6)],
    [c(12), c(6)],
  ], {
    phase: 'playing',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: 'nope',
    turn: 1,
  });
  r.lead = { seat: 0, kind: 'single', n: 1, power: 10, cards: [leadCard], responders: 4 };
  action(r, 1, 'play', { cards: [six.id] });
  assert.equal(r.phase, 'wind');
  assert.equal(r.windGiverSeat, 1);
  assert.ok(r.rankings.includes(1));
});

test('给风超时：给风者已出完仍会自动给风；机器人皇帝优先给公开侍卫', () => {
  const r = makeRoom([
    [], [c(8), c(6)], [c(9), c(6)], [c(10), c(6)], [c(11), c(6)],
  ], {
    phase: 'wind',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: 'nope',
    guardPublic: true,
    windGiverSeat: 0,
    rankings: [0],
  });
  r.players[0].done = true;
  r.players[0].rank = 1;
  bh.onTimeout(r);
  assert.equal(r.phase, 'playing');
  assert.ok(r.lastWind);
  assert.equal(r.turn, r.lastWind.seat);

  const r2 = makeRoom([
    [], [c(8), c(6)], [c(9), c(6)], [c(10), c(6)], [c(11), c(6)],
  ], {
    phase: 'wind',
    emperorSeat: 0,
    guardSeat: 2,
    guardCardId: 'nope',
    guardPublic: true,
    windGiverSeat: 0,
    rankings: [0],
  });
  r2.players[0].bot = true;
  r2.players[0].done = true;
  r2.players[0].rank = 1;
  bh.onBot(r2);
  assert.equal(r2.lastWind.seat, 2, '机器人皇帝优先给侍卫');
});

test('过牌不准上：过牌后本轮不再轮到该玩家', () => {
  const lead = c(9, 0);
  const r = makeRoom([
    [c(7), c(6)],
    [c(8), c(6)],
    [c(10), c(6)],
    [c(11), c(6)],
    [c(12), c(6)],
  ], {
    phase: 'playing',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: 'nope',
    turn: 0,
  });
  // P0 领出单张9
  const p0 = r.players[0].hand.find((x) => x.rank === 7);
  p0.rank = 9;
  action(r, 0, 'play', { cards: [p0.id] });
  assert.equal(r.turn, 1);
  action(r, 1, 'pass');
  assert.equal(r.turn, 2);
  action(r, 2, 'pass');
  assert.equal(r.turn, 3);
  action(r, 3, 'pass');
  assert.equal(r.turn, 4);
  action(r, 4, 'pass');
  // 所有其他人都过：本轮结束，领出者重新领出，过牌记录清空
  assert.equal(r.lead, null);
  assert.equal(r.turn, 0);
  assert.deepEqual(r.passed, Array(5).fill(false));
  assert.deepEqual(r.playedBy, Array(5).fill(null));
});
