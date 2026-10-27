// A whole tournament with 8 simulated phones: lobby, league, semis, final, prize claim.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 3998;
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, RESOLVE_MS: '2', TURN_MS: '300', NEXT_GAME_MS: '50', BOT_MS: '1', MATCH_READY_MS: '1500', SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' }, stdio: 'inherit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = m => { console.error('FAIL:', m); srv.kill(); process.exit(1); };

function phone(n, { lazy = false } = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const P = { ws, n, tour: null, state: null, errors: [], matches: 0 };
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.t === 'tour') P.tour = m;
    if (m.t === 'tourMatch' && !lazy) { P.matches++; setTimeout(() => ws.send(JSON.stringify({ t: 'join', code: m.code })), 5); }
    if (m.t === 'state') {
      P.state = m; const g = m.game;
      if (m.phase === 'play' && g && g.turn === m.me && !g.resolving) {
        const led = g.trick.length ? g.trick[0].c.s : null;
        const legal = led && g.hand.some(c => c.s === led) ? g.hand.filter(c => c.s === led) : g.hand;
        setTimeout(() => ws.send(JSON.stringify({ t: 'play', id: legal[Math.floor(Math.random() * legal.length)].id })), 1);
      }
      if (m.phase === 'result' && m.me >= 0 && !m.ready.includes(m.me)) ws.send(JSON.stringify({ t: 'ready' }));
      if (m.phase === 'final' && m.match) { ws.send(JSON.stringify({ t: 'leave' })); P.state = null; }
    }
    if (m.t === 'error') P.errors.push(m.text);
  });
  P.send = o => ws.send(JSON.stringify(o));
  P.open = new Promise(r => ws.on('open', r));
  return P;
}

(async () => {
  await sleep(500);
  // H is host; G never taps "ready" so bots must fill in for them.
  const names = ['H', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
  const P = names.map(n => phone(n, { lazy: n === 'G' }));
  await Promise.all(P.map(p => p.open));
  P.forEach(p => p.send({ t: 'hello', pid: 'tour-pid-' + p.n + '-xxxx', name: 'P' + p.n, icon: '🐯' }));
  await sleep(100);
  const [H, A, B] = P;
  H.send({ t: 'tourCreate', settings: { gpm: 1, perTeam: 6, prize: '₹500 Amazon voucher' } });
  await sleep(400);
  const code = H.tour.code;
  for (const p of P.slice(1)) p.send({ t: 'join', code });
  await sleep(500);
  if (H.tour.players.length !== 8) fail('not 8 players: ' + H.tour.players.length);
  // Mutual partner pick: H picks A, A picks H -> team.
  const id = n => H.tour.players.find(p => p.name === 'P' + n).id;
  H.send({ t: 'tour', a: 'pick', id: id('A') }); await sleep(300);
  if (H.tour.teams.length) fail('team formed on one-sided pick');
  A.send({ t: 'tour', a: 'pick', id: id('H') }); await sleep(400);
  if (H.tour.teams.length !== 1) fail('mutual pick did not form a team');
  B.send({ t: 'tour', a: 'start' }); await sleep(300);
  if (!B.errors.length) fail('non-host could start');
  H.send({ t: 'tour', a: 'start' }); await sleep(300);
  if (!H.errors.some(e => /team nahi bani/.test(e))) fail('started with solo players');
  H.send({ t: 'tour', a: 'randomize' }); await sleep(400);
  if (H.tour.teams.length !== 4) fail('randomize did not make 4 teams');
  H.send({ t: 'tour', a: 'teamName', team: 0, name: 'Kot Killers' });
  H.send({ t: 'tour', a: 'start' }); await sleep(500);
  if (H.tour.phase !== 'league') fail('league did not start: ' + H.tour.phase + ' ' + H.errors.join('|'));
  const league = H.tour.matches.length;
  const per = Array(4).fill(0); H.tour.matches.forEach(m => { per[m.a]++; per[m.b]++; });
  if (per.some(x => x < 6)) fail('a team has fewer than 6 league matches: ' + per);
  const t0 = Date.now();
  while (H.tour.phase !== 'done' && Date.now() - t0 < 120000) await sleep(200);
  if (H.tour.phase !== 'done') fail('tournament did not finish: ' + H.tour.phase + ' ' + JSON.stringify(H.tour.matches.map(m => [m.stage, m.status, m.gameNo])));
  const T = H.tour;
  const semis = T.matches.filter(m => m.stage === 'semi'), fin = T.matches.filter(m => m.stage === 'final');
  if (semis.length !== 2 || fin.length !== 1) fail('knockouts wrong');
  if (T.champion !== fin[0].winner || T.champion === null) fail('champion mismatch');
  for (const m of T.matches) {
    if (m.status !== 'done') fail('match not done');
    const sum = m.dehle[0] + m.dehle[1];
    if (sum !== 4 * m.gameNo) fail('dehle do not add up in match ' + m.id);
    const expPts = [0, 0];
    // points: dehle each, but a Kot game is 6-0 instead of 4-0
    if (m.pts[0] + m.pts[1] !== sum + 2 * (m.kots[0] + m.kots[1])) fail('points do not add up in match ' + m.id + ' ' + JSON.stringify(m));
  }
  // Prize claim: only the champion team can claim, and the host sees it.
  const champs = T.teams[T.champion].ids.map(i => T.players.find(p => p.id === i).name);
  const winner = P.find(p => champs.includes('P' + p.n));
  const loser = P.find(p => !champs.includes('P' + p.n));
  loser.send({ t: 'tour', a: 'claim', email: 'x@y.com' }); await sleep(300);
  if (!loser.errors.some(e => /jeetne wali/.test(e))) fail('loser could claim');
  winner.send({ t: 'tour', a: 'claim', email: 'winner@gmail.com' }); await sleep(500);
  if (!H.tour.claims || !H.tour.claims.some(c => c.email === 'winner@gmail.com')) fail('host does not see the claim');
  if (A.tour.claims && A !== H) fail('non-host sees claims');
  console.log('PASS', { leagueMatches: league, perTeam: per, champion: T.teams[T.champion].name, botFilledFor: 'PG', semis: semis.map(m => m.pts), final: fin[0].pts, claims: H.tour.claims });
  srv.kill(); process.exit(0);
})().catch(e => fail(e.stack));
