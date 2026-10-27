// Testing with bots: a 2-player friends table filled with bots, and a solo host
// with a bot partner plus two all-bot teams playing a full tournament.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 3997;
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, RESOLVE_MS: '2', TURN_MS: '300', NEXT_GAME_MS: '50', BOT_MS: '1', MATCH_READY_MS: '300', SUPABASE_URL: '', LIVEKIT_URL: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = m => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
function phone(n) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const P = { ws, tour: null, state: null, errors: [] };
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.t === 'tour') P.tour = m;
    if (m.t === 'tourMatch') setTimeout(() => ws.send(JSON.stringify({ t: 'join', code: m.code })), 5);
    if (m.t === 'state') {
      P.state = m; const g = m.game;
      if (m.phase === 'play' && g && g.turn === m.me && !g.resolving) {
        const led = g.trick.length ? g.trick[0].c.s : null;
        const legal = led && g.hand.some(c => c.s === led) ? g.hand.filter(c => c.s === led) : g.hand;
        setTimeout(() => ws.send(JSON.stringify({ t: 'play', id: legal[0].id })), 1);
      }
      if (m.phase === 'result' && m.me >= 0 && !m.ready.includes(m.me)) ws.send(JSON.stringify({ t: 'ready' }));
      if (m.phase === 'final' && m.match) ws.send(JSON.stringify({ t: 'leave' }));
    }
    if (m.t === 'error') P.errors.push(m.text);
  });
  P.send = o => ws.send(JSON.stringify(o));
  P.open = new Promise(r => ws.on('open', r));
  ws.on('open', () => P.send({ t: 'hello', pid: 'bots-pid-' + n + '-xxxx', name: n, icon: '🐯' }));
  return P;
}
(async () => {
  await sleep(500);
  // --- table: 2 humans + bots
  const [A, B] = [phone('TA'), phone('TB')];
  await Promise.all([A.open, B.open]); await sleep(100);
  A.send({ t: 'create' }); await sleep(150);
  B.send({ t: 'join', code: A.state.code }); await sleep(150);
  A.send({ t: 'host', a: 'settings', settings: { games: 5 } });
  A.send({ t: 'host', a: 'fillBots' }); await sleep(100);
  if (A.state.seats.filter(s => s && s.bot).length !== 2) fail('fillBots did not fill 2 seats');
  A.send({ t: 'host', a: 'start' });
  for (let i = 0; i < 200 && A.state.phase !== 'final'; i++) await sleep(100);
  if (A.state.phase !== 'final') fail('bot table did not finish: ' + A.state.phase);
  const table = { played: A.state.table.played };
  A.send({ t: 'leave' }); B.send({ t: 'leave' }); await sleep(100);
  // --- tournament: 1 human + bot partner + 2 bot teams
  const H = phone('Solo'); await H.open; await sleep(100);
  H.send({ t: 'tourCreate', settings: { gpm: 1, perTeam: 6 } }); await sleep(500);
  const me = H.tour.players.find(p => p.you);
  H.send({ t: 'tour', a: 'botPartner', id: me.id });
  H.send({ t: 'tour', a: 'botTeam' }); H.send({ t: 'tour', a: 'botTeam' }); H.send({ t: 'tour', a: 'botTeam' });
  await sleep(400);
  if (H.tour.teams.length !== 4) fail('expected 4 teams, got ' + H.tour.teams.length);
  H.send({ t: 'tour', a: 'removeTeam', team: 3 }); await sleep(400);
  if (H.tour.teams.length !== 3) fail('removeTeam did not remove the bot team');
  H.send({ t: 'tour', a: 'start' });
  for (let i = 0; i < 1500 && H.tour.phase !== 'done'; i++) await sleep(100);
  if (H.tour.phase !== 'done') fail('tournament stuck in ' + H.tour.phase + ' ' + JSON.stringify(H.tour.matches.map(m => m.status)));
  console.log('PASS', { table, matches: H.tour.matches.length, champion: H.tour.teams[H.tour.champion].name, errors: [...A.errors, ...H.errors] });
  srv.kill(); process.exit(0);
})().catch(e => fail(e.message));
