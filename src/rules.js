'use strict';
// 规则层：从原 server.js 原样迁移，仅移除内部 setTimeout 调度（由 engine 统一 armTurn）。

const suitPower = {1: 4, 3: 3, 0: 2, 2: 1};

function deck(){const d=[];for(let z=0;z<3;z++){for(let s=0;s<4;s++)for(let r=5;r<=15;r++)d.push({id:`${z}-${s}-${r}`,rank:r,suit:s});d.push({id:`${z}-BJ`,rank:16,suit:4,color:'black'},{id:`${z}-RJ`,rank:17,suit:4,color:'red'});}return d;}
function classify(cards){const n=cards.length,rs=cards.map(c=>c.rank),ss=cards.map(c=>c.suit),counts=new Map();rs.forEach(r=>counts.set(r,(counts.get(r)||0)+1));if(n===3&&rs.every(r=>r===rs[0])&&rs[0]>=16)return{kind:'king3',n,power:rs[0]};if(n===2&&rs.every(r=>r===rs[0])&&rs[0]>=16)return{kind:'king2',n,power:rs[0]};if(n===3&&[5,10,13].every(r=>counts.get(r)===1)){let pure=new Set(ss).size===1;return{kind:pure?'pureLeg':'mixedLeg',n,power:pure?suitPower[ss[0]]:0};}if(n>=3&&counts.size===1)return{kind:'bomb',n,power:rs[0]};if(n>=6&&n%2===0&&rs.every(r=>r>=5&&r<=14)&&[...counts.values()].every(v=>v===2)){let q=[...counts.keys()].sort((a,b)=>a-b);if(q.length>=3&&q.every((r,i)=>!i||r===q[i-1]+1))return{kind:'doubleStraight',n,power:q.at(-1)};}if(n>=3&&rs.every(r=>r>=5&&r<=14)&&counts.size===n){let q=[...rs].sort((a,b)=>a-b);if(q.every((r,i)=>!i||r===q[i-1]+1))return{kind:'straight',n,power:q.at(-1)};}if(counts.size===1)return{kind:n===1?'single':n===2?'pair':'triple',n,power:rs[0]};return null;}
const trump=k=>({single:0,pair:0,triple:0,straight:0,doubleStraight:0,bomb:1,mixedLeg:2,king2:3,pureLeg:4,king3:5}[k]??-1);
function beats(a,b){if(!a)return false;if(!b)return true;if(a.kind!==b.kind){if(a.kind==='mixedLeg'&&['bomb','straight','doubleStraight'].includes(b.kind))return true;if(b.kind==='mixedLeg'&&['bomb','straight','doubleStraight'].includes(a.kind))return false;return trump(a.kind)>trump(b.kind);}if(['pureLeg','mixedLeg','king2','king3'].includes(a.kind))return a.power>b.power;if(a.kind==='bomb')return a.n>b.n||(a.n===b.n&&a.power>b.power);return a.n===b.n&&a.power>b.power;}
function teamName(room,team){return team===0?'红队':'蓝队';}
function assignTeams(r){let order=[0,1,2,3,4,5];for(let i=5;i>0;i--){let j=Math.floor(Math.random()*(i+1));[order[i],order[j]]=[order[j],order[i]];}r.positions=Array(6);r.teams=Array(6);let first=Math.floor(Math.random()*2);order.forEach((seat,pos)=>{r.positions[seat]=pos;r.teams[seat]=(pos+first)%2;});let red=r.teams.flatMap((t,i)=>t===0?[i+1]:[]),blue=r.teams.flatMap((t,i)=>t===1?[i+1]:[]);r.log.push(`系统重新分队并调整座位：红队 ${red.join('、')}号玩家；蓝队 ${blue.join('、')}号玩家`);}
function nextActive(r,from){let fromPos=r.positions?.[from]??from;for(let step=1;step<=6;step++){let pos=(fromPos+step)%6,i=r.positions?.indexOf(pos)??pos;if(!r.players[i].done){r.turn=i;return;}}r.finished=true;}
// 接风：领出者已出完时，由顺时针下一位仍在场的同队玩家领出；找不到则按正常顺位。
function nextTeammate(r,leader){let fromPos=r.positions?.[leader]??leader;for(let step=1;step<=6;step++){let pos=(fromPos+step)%6,i=r.positions?.indexOf(pos)??pos;if(i!==leader&&r.teams[i]===r.teams[leader]&&!r.players[i].done){r.turn=i;r.log.push(`接风：${r.players[i].name} 接手出牌`);return true;}}return false;}
function awardTrick(r){if(!r.lead)return;let team=r.teams[r.lead.seat];r.scores[team]+=r.trickPoints;r.log.push(`${teamName(r,team)}收本轮 ${r.trickPoints} 分`);r.trickPoints=0;if(r.passed)r.passed=Array(6).fill(false);}
function completeRound(r){let leftover=0,penalty=0,emperorTeam=r.bigEmperor===null?0:r.teams[r.bigEmperor];for(let i=0;i<6;i++){let hand=r.players[i].hand;if(!hand.length)continue;let points=hand.reduce((sum,c)=>sum+(c.rank===5?5:(c.rank===10||c.rank===13?10:0)),0);leftover+=points;r.scores[1-r.teams[i]]+=points;if(r.teams[i]!==emperorTeam){r.scores[r.teams[i]]-=20;penalty+=20;}}r.leftoverPoints=leftover;r.penalty=penalty;r.roundWinner=r.scores[0]===r.scores[1]?null:(r.scores[0]>r.scores[1]?0:1);r.finished=true;r.gamesPlayed++;r.matchResults.push({round:r.gamesPlayed,bigSet:r.bigSet,red:r.scores[0],blue:r.scores[1],winner:r.roundWinner,emperorTeam,leftover,penalty});r.log.push(`大皇所在${teamName(r,emperorTeam)}成员被抓不扣分；未出手分牌 ${leftover} 分转给对应对方，非大皇队被抓扣 ${penalty} 分`);r.log.push(`本小局比分红 ${r.scores[0]}：蓝 ${r.scores[1]}，${r.roundWinner===null?'平局':`${teamName(r,r.roundWinner)}获胜`}`);r.log.push(`第${r.gamesPlayed}小局结束`);}
function checkRoundEnd(r){let done=[0,1].map(team=>r.players.every((p,i)=>r.teams[i]!==team||p.done));if(done[0]||done[1]){awardTrick(r);completeRound(r);return true;}return false;}
function finishCard(r,seat,cards){let p=r.players[seat];p.hand=p.hand.filter(c=>!cards.some(x=>x.id===c.id));r.trickPoints+=cards.reduce((s,c)=>s+(c.rank===5?5:(c.rank===10||c.rank===13?10:0)),0);let move=classify(cards),responders=r.players.filter((x,i)=>i!==seat&&!x.done).length;r.lead={seat,...move,cards:cards.map(c=>({...c})),responders};r.playedBy[seat]=cards.map(c=>({...c}));r.passes=0;if(r.passed)r.passed[seat]=false;r.log.push(`${p.name} 出了${cards.length}张牌`);if(!p.hand.length){p.done=true;if(r.bigEmperor===null){r.bigEmperor=seat;r.log.push(`${p.name} 成为大皇`);}}if(!checkRoundEnd(r))nextActive(r,seat);}
function passTurn(r,seat,name){if(!r.lead)throw Error('当前没有上家牌，不能不要');if(!r.passed)r.passed=Array(6).fill(false);r.passed[seat]=true;r.passes++;r.log.push(`${name} 不要`);if(r.passes>=r.lead.responders){let leader=r.lead.seat;awardTrick(r);r.lead=null;r.passes=0;r.playedBy=Array(6).fill(null);if(!r.players[leader].done)r.turn=leader;else if(!nextTeammate(r,leader))nextActive(r,leader);r.log.push('一轮无人压牌，领牌队得分');}else nextActive(r,seat);}
function startHand(r){let cards=deck();for(let i=cards.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]];}r.players.forEach((p,i)=>{p.hand=cards.slice(i*23,(i+1)*23);p.done=false;});r.started=true;let previousEmperor=r.bigEmperor;r.turn=r.gamesPlayed===0?Math.floor(cards.findIndex(c=>c.rank===6&&c.suit===1)/23):(previousEmperor??0);r.lead=null;r.passes=0;r.passed=Array(6).fill(false);r.finished=false;r.roundWinner=null;r.leftoverPoints=0;r.penalty=0;r.trickPoints=0;r.playedBy=Array(6).fill(null);r.scores=[0,0];r.bigEmperor=null;r.log.push(r.gamesPlayed===0?'首局由持红桃6的玩家先出牌':`本局由上一局大皇（${r.players[r.turn].name}）先出牌`);r.log.push(`第${r.gamesPlayed+1}小局发牌完成`);}
function startGame(r){assignTeams(r);r.gamesPlayed=0;r.bigSet=1;r.matchResults=[];r.bigEmperor=null;startHand(r);}
function nextGame(r){if(!r.finished)throw Error('本小局尚未结束');if(r.gamesPlayed>=3){r.bigSet++;r.gamesPlayed=0;r.matchResults=[];assignTeams(r);}startHand(r);}
const STRONG_KINDS = new Set(['bomb', 'mixedLeg', 'pureLeg', 'king2', 'king3']);

function cardPoints(cards) {
  return cards.reduce((sum, c) => sum + (c.rank === 5 ? 5 : (c.rank === 10 || c.rank === 13 ? 10 : 0)), 0);
}

function comboBreakCost(r, seat, cards) {
  const hand = r.players[seat].hand;
  const total = new Map();
  for (const c of hand) total.set(c.rank, (total.get(c.rank) || 0) + 1);
  const used = new Map();
  for (const c of cards) used.set(c.rank, (used.get(c.rank) || 0) + 1);
  let cost = 0;
  for (const [rank, u] of used) {
    const t = total.get(rank) || 0;
    if (t < 2 || u >= t) continue;
    if (rank >= 16) cost += 10;
    else if (t >= 3) cost += 10;
    else cost += 1;
  }
  for (let suit = 0; suit < 4; suit++) {
    const has = [5, 10, 13].every((rr) => hand.some((c) => c.rank === rr && c.suit === suit));
    if (!has) continue;
    const n = cards.filter((c) => c.suit === suit && (c.rank === 5 || c.rank === 10 || c.rank === 13)).length;
    if (n > 0 && n < 3) cost += 10;
  }
  const hasMixed = [5, 10, 13].every((rr) => (total.get(rr) || 0) > 0);
  if (hasMixed) {
    const usedRanks = [5, 10, 13].filter((rr) => (used.get(rr) || 0) > 0).length;
    if (usedRanks > 0 && usedRanks < 3) cost += 5;
  }
  return cost;
}

function botCandidates(r, seat) {
  const hand = r.players[seat].hand;
  const lead = r.lead;
  const out = [];
  const seen = new Set();
  const add = (cs) => {
    if (!cs?.length) return;
    const key = cs.map((c) => c.id).sort().join(',');
    if (seen.has(key)) return;
    const type = classify(cs);
    if (!type || !beats(type, lead)) return;
    seen.add(key);
    out.push({ cards: cs, type, breaks: comboBreakCost(r, seat, cs), points: cardPoints(cs) });
  };
  for (const c of hand) add([c]);
  const groups = new Map();
  for (const c of hand) {
    if (!groups.has(c.rank)) groups.set(c.rank, []);
    groups.get(c.rank).push(c);
  }
  for (const g of groups.values()) for (let n = 2; n <= g.length; n++) add(g.slice(0, n));
  for (const a of hand.filter((c) => c.rank === 5)) {
    for (const b of hand.filter((c) => c.rank === 10)) {
      for (const k of hand.filter((c) => c.rank === 13)) add([a, b, k]);
    }
  }
  const ranks = [...groups.keys()].filter((x) => x >= 5 && x <= 14).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    const seq = [];
    for (let j = i; j < ranks.length; j++) {
      const x = ranks[j];
      if (seq.length && x !== seq[seq.length - 1] + 1) break;
      seq.push(x);
      if (seq.length >= 3) {
        add(seq.map((x) => groups.get(x)[0]));
        if (seq.every((x) => groups.get(x).length >= 2)) add(seq.flatMap((x) => groups.get(x).slice(0, 2)));
      }
    }
  }
  return out;
}

function botAct(r) {
  if (!r.started || r.finished) return;
  const seat = r.turn;
  const p = r.players[seat];
  if (!p?.bot) return;
  const lead = r.lead;
  // 队友领出时不压队友，尤其不要拆/盖炸弹、五十K、双王。
  if (lead && lead.seat !== seat && r.teams[lead.seat] === r.teams[seat]) {
    passTurn(r, seat, p.name);
    return;
  }
  const cands = botCandidates(r, seat);
  if (!cands.length) {
    passTurn(r, seat, p.name);
    return;
  }
  const urgent = (r.trickPoints || 0) >= 10 || (lead && STRONG_KINDS.has(lead.kind));
  if (!lead) {
    // 领出：优先打有分的完整炸弹/五十K，帮队伍拿分。
    const rich = cands.filter((x) => STRONG_KINDS.has(x.type.kind) && x.points > 0 && x.breaks === 0);
    if (rich.length) {
      rich.sort((a, b) => b.points - a.points || trump(a.type.kind) - trump(b.type.kind) || a.type.power - b.type.power || a.type.n - b.type.n);
      finishCard(r, seat, rich[0].cards);
      return;
    }
    // 否则出小牌：先不拆牌、不带分。
    const simple = cands.filter((x) => !STRONG_KINDS.has(x.type.kind));
    const pool = simple.length ? simple : cands;
    pool.sort((a, b) => a.breaks - b.breaks || a.points - b.points || a.type.n - b.type.n || a.type.power - b.type.power);
    finishCard(r, seat, pool[0].cards);
    return;
  }
  // 跟敌方牌：优先不拆牌的普通牌型；高分牌局才动炸弹/五十K/双王。
  const safe = cands.filter((x) => x.breaks === 0 && !STRONG_KINDS.has(x.type.kind));
  if (safe.length) {
    safe.sort((a, b) => trump(a.type.kind) - trump(b.type.kind) || a.type.n - b.type.n || a.type.power - b.type.power);
    finishCard(r, seat, safe[0].cards);
    return;
  }
  if (urgent) {
    const pool = cands.filter((x) => x.breaks === 0);
    const use = pool.length ? pool : cands;
    use.sort((a, b) => a.breaks - b.breaks || trump(a.type.kind) - trump(b.type.kind) || a.type.power - b.type.power || a.type.n - b.type.n);
    finishCard(r, seat, use[0].cards);
    return;
  }
  // 低分牌局且只能拆牌/动炸弹：先不要，保存实力。
  passTurn(r, seat, p.name);
}

module.exports = { deck, classify, trump, beats, teamName, assignTeams, nextActive, awardTrick, completeRound, checkRoundEnd, finishCard, passTurn, startHand, startGame, nextGame, botAct };
