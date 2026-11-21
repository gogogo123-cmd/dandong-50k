'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const bh = require('../src/baohuang/engine');
const { findTriples } = require('../src/baohuang/cards');

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
  assert.ok(r.phase === 'buy6' || r.phase === 'emperor');
  const all = r.players.flatMap((p) => p.hand);
  assert.equal(all.length, 157);
  if (r.phase === 'emperor') {
    for (const p of r.players) assert.equal(p.hand.filter((x) => x.rank === 6).length, 1);
  }
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

test('手动买6：买方选卖方，支付优先级校验，完成后进入皇帝确认', () => {
  const two = c(15, 0);
  const small = c(16, 4);
  const hands = [
    [two, small, c(7)],
    [c(6), c(6), c(8)],
    [c(6), c(9)],
    [c(6), c(10)],
    [c(6), c(11)],
  ];
  const r = makeRoom(hands, {
    phase: 'buy6',
    candidateSeat: 2,
    turn: 0,
    buy6Log: [],
  });
  assert.throws(
    () => action(r, 0, 'buy6', { seller: 1, cards: [small.id] }),
    (e) => e.code === 'bad-cards',
  );
  action(r, 0, 'buy6', { seller: 1 });
  assert.equal(r.players[0].hand.filter((x) => x.rank === 6).length, 1);
  assert.equal(r.players[1].hand.filter((x) => x.rank === 6).length, 1);
  assert.ok(r.players[0].hand.every((x) => x.id !== two.id), '优先支付2');
  assert.ok(r.players[1].hand.some((x) => x.id === two.id));
  assert.equal(r.buy6Log.length, 1);
  assert.equal(r.phase, 'emperor');
  assert.equal(r.turn, 2);
});

test('手动买6：同档支付牌由玩家自选花色', () => {
  const twoA = c(15, 0);
  const twoB = c(15, 2);
  const hands = [
    [twoA, twoB, c(7)],
    [c(6), c(6), c(8)],
    [c(6), c(9)],
    [c(6), c(10)],
    [c(6), c(11)],
  ];
  const r = makeRoom(hands, { phase: 'buy6', candidateSeat: 2, turn: 0, buy6Log: [] });
  const state = bh.publicState(r, 0);
  assert.deepEqual((state.buy6PayIds || []).slice().sort(), [twoA.id, twoB.id].sort(), '两个2都应可选');
  action(r, 0, 'buy6', { seller: 1, cards: [twoB.id] });
  assert.ok(r.players[0].hand.some((x) => x.id === twoA.id), '保留未选择的2');
  assert.ok(!r.players[0].hand.some((x) => x.id === twoB.id));
  assert.equal(r.buy6Log[0].paid.id, twoB.id);
  assert.equal(r.buy6Log[0].paid.suit, twoB.suit);
  assert.ok(r.players[1].hand.some((x) => x.id === twoB.id), '卖方得到玩家指定的2');
});

test('手动买6：卖方必须有多余6；机器人自动完成买6', () => {
  const hands = [
    [c(15, 0), c(7)],
    [c(6), c(6), c(8)],
    [c(6), c(9)],
    [c(6), c(10)],
    [c(6), c(11)],
  ];
  const r = makeRoom(hands, { phase: 'buy6', candidateSeat: 2, turn: 0, buy6Log: [] });
  assert.throws(
    () => action(r, 0, 'buy6', { seller: 2 }),
    (e) => e.code === 'bad-target',
  );
  r.players[0].bot = true;
  bh.onBot(r);
  assert.equal(r.players[0].hand.filter((x) => x.rank === 6).length, 1);
  assert.equal(r.phase, 'emperor');
  assert.equal(r.buy6Log.length, 1);
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

test('跟牌超时不自动过牌，必须玩家自己点不要', () => {
  const r = makeRoom([
    [c(8), c(6)],
    [c(7), c(6)],
    [c(10), c(6)],
    [c(11), c(6)],
    [c(12), c(6)],
  ], {
    phase: 'playing',
    emperorSeat: 0,
    guardSeat: 1,
    guardCardId: 'nope',
    turn: 1,
  });
  r.lead = { seat: 0, kind: 'single', n: 1, power: 9, cards: [c(9, 0)], responders: 4 };
  bh.onTimeout(r);
  assert.equal(r.passed[1], false, '超时不会自动过牌');
  assert.equal(r.turn, 1, '超时后仍停在当前玩家');
  assert.ok(!r.log.some((x) => x.includes('不要')), '超时日志不出现自动不要');
  action(r, 1, 'pass');
  assert.equal(r.passed[1], true, '玩家手动点不要后才过牌');
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

test('整局机器人依次行动：不会连续由同一座位出牌，真人不会被跳过', () => {
  const r = makeRoom(Array.from({ length: 5 }, () => []), { started: false, phase: 'lobby' });
  r.players.forEach((p, i) => { p.bot = i !== 0; });
  bh.startGame(r);

  let humanCardTurns = 0;
  let steps = 0;
  while (!r.finished && steps++ < 4000) {
    const actor = bh.actorSeat(r);
    assert.notEqual(actor, null, '每个阶段都应有操作者');
    if (r.phase === 'playing') assert.equal(r.players[actor].done, false, '不能轮到已出完的玩家');
    if (r.phase === 'playing' && actor === 0) humanCardTurns += 1;

    if (r.players[actor].bot) {
      bh.onBot(r);
      // 机器人出完一手后，除“本墩结束、由最后出牌者重新领出”外，必须换人。
      if (!r.finished && r.phase === 'playing' && r.lead && bh.actorSeat(r) === actor) {
        assert.fail(`机器人 ${actor} 连续出牌，跳过了其他玩家`);
      }
      continue;
    }

    if (r.phase === 'buy6') {
      const seller = r.players.findIndex((p, i) => i !== actor && p.hand.filter((c) => c.rank === 6).length > 1);
      action(r, actor, 'buy6', { seller });
    } else if (r.phase === 'emperor') {
      const triple = findTriples(r.players[actor].hand)[0];
      if (triple) action(r, actor, 'emperor', { cards: triple.cards.map((c) => c.id) });
      else action(r, actor, 'emperor', { yield: true });
    } else if (r.phase === 'wind') {
      action(r, actor, 'wind', { seat: r.players.findIndex((p, i) => i !== actor && !p.done && p.hand.length) });
    } else if (r.phase === 'playing') {
      if (r.lead && r.lead.seat !== actor) action(r, actor, 'pass');
      else {
        const p = r.players[actor];
        const card = p.hand.filter((c) => c.rank !== 6 || p.hand.length === 1)
          .sort((a, b) => a.rank - b.rank || a.suit - b.suit)[0];
        action(r, actor, 'play', { cards: [card.id] });
      }
    }
  }

  assert.ok(r.finished, '整局应正常结算');
  assert.ok(humanCardTurns >= 3, `真人应持续参与出牌，实际 ${humanCardTurns} 次`);
});

test('不要后清空该玩家本轮早先出的牌，出牌区应显示不要', () => {
  const r = makeRoom([
    [c(7), c(7)],
    [c(8), c(7)],
    [c(9), c(7)],
    [c(10), c(7)],
    [c(7), c(7)],
  ], { phase: 'playing', turn: 0 });
  action(r, 0, 'play', { cards: [r.players[0].hand[0].id] });
  action(r, 1, 'play', { cards: [r.players[1].hand[0].id] });
  action(r, 2, 'play', { cards: [r.players[2].hand[0].id] });
  action(r, 3, 'play', { cards: [r.players[3].hand[0].id] });
  action(r, 4, 'pass');
  action(r, 0, 'pass');
  action(r, 1, 'pass');
  assert.equal(r.passed[1], true);
  assert.equal(r.lead.seat, 3, '本轮仍由出了10的玩家领出');
  assert.equal(r.players[1].hand.length, 1, '玩家1仍有手牌');
  const s = bh.publicState(r, 0);
  assert.equal(s.passed[1], true);
  assert.equal(s.players[1].lastPlay, null, '不要后不再显示早先出的8');
  assert.equal(s.players[0].lastPlay, null, '不要后不再显示早先出的7');
});

test('皇帝让位转满一圈：上贡的2凑成三张必须登基，不得重新发牌', () => {
  const twoC1 = c(15, 2), twoC2 = c(15, 2), twoC3 = c(15, 2), twoC4 = c(15, 2);
  const r = makeRoom([
    [twoC1, twoC2, c(7, 0)],
    [twoC3, c(9, 0)],
    [twoC4, c(15, 1), c(10, 0)],
    [c(15, 1), c(11, 0)],
    [c(15, 0), c(12, 0)],
  ], { phase: 'emperor', candidateSeat: 0, initialCandidateSeat: 0, transferCount: 0 });
  for (const seat of [0, 4, 3, 2, 1]) {
    action(r, seat, 'emperor', { yield: true });
  }
  assert.equal(r.redealCount, 0, '凑成三张时不应重新发牌');
  assert.equal(r.phase, 'emperor');
  assert.equal(r.candidateSeat, 0);
  assert.equal(bh.publicState(r, 0).candidateSeat, 0);
  assert.equal(r.players[0].hand.filter((x) => x.rank === 15 && x.suit === 2).length, 3);
  assert.throws(
    () => action(r, 0, 'emperor', { yield: true }),
    (e) => e.code === 'must-enthrone',
  );
  const triple = r.players[0].hand.filter((x) => x.rank === 15 && x.suit === 2);
  action(r, 0, 'emperor', { cards: triple.map((x) => x.id) });
  assert.equal(r.phase, 'playing');
  assert.equal(r.emperorSeat, 0);
  assert.equal(r.guardSeat, 1);
});
