// Plays full tables with 4 simulated phones against a local server.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 3999;
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, RESOLVE_MS: '5', TURN_MS: '400', LIVEKIT_URL: 'wss://example.livekit.cloud', LIVEKIT_API_KEY: 'testkey', LIVEKIT_API_SECRET: 'testsecrettestsecrettestsecret12' }, stdio: 'inherit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = m => { console.error('FAIL:', m); srv.kill(); process.exit(1); };

function phone(n, opts = {}) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const P = { ws, n, state: null, events: [], errors: [], idle: !!opts.idle };
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.t === 'state') {
      P.state = m;
      const g = m.game;
      if (m.phase === 'play' && g && g.turn === m.me && !g.resolving && !P.idle) {
        if (g.hand.length !== g.counts[m.me]) fail('hand/count mismatch');
        const led = g.trick.length ? g.trick[0].c.s : null;
        const legal = led && g.hand.some(c => c.s === led) ? g.hand.filter(c => c.s === led) : g.hand;
        const c = legal[Math.floor(Math.random() * legal.length)];
        setTimeout(() => ws.send(JSON.stringify({ t: 'play', id: c.id })), 2);
      }
      if (m.phase === 'result' && m.me >= 0 && !m.ready.includes(m.me)) setTimeout(() => ws.send(JSON.stringify({ t: 'ready' })), 2);
    }
    if (m.t === 'event') P.events.push(m.e);
    if (m.t === 'error') P.errors.push(m.text);
    if (m.t === 'voiceToken') P.voice = m;
  });
  P.send = o => ws.send(JSON.stringify(o));
  P.open = new Promise(r => ws.on('open', r));
  return P;
}

(async () => {
  await sleep(500);
  const A = phone('A'), B = phone('B'), C = phone('C'), D = phone('D', { idle: true });
  await Promise.all([A, B, C, D].map(p => p.open));
  [A, B, C, D].forEach((p, i) => p.send({ t: 'hello', pid: 'test-pid-' + p.n + '-xxxx', name: 'P' + p.n, icon: '🐯' }));
  await sleep(100);
  A.send({ t: 'create' });
  await sleep(100);
  const code = A.state.code;
  for (const p of [B, C, D]) p.send({ t: 'join', code });
  await sleep(150);
  if (A.state.seats.filter(Boolean).length !== 4) fail('not 4 seated');
  B.send({ t: 'host', a: 'start' });            // not host -> refused
  await sleep(50);
  if (!B.errors.length) fail('non-host could start');
  A.send({ t: 'host', a: 'settings', settings: { games: 5 } });
  A.send({ t: 'host', a: 'teamName', team: 0, name: 'Kot Killers' });
  A.send({ t: 'host', a: 'start' });
  // Voice: everyone gets the same table room, even if they ask for a team channel.
  A.send({ t: 'voiceToken', channel: 'team' }); await sleep(150);
  if (!A.voice || !A.voice.token) fail('no voice token');
  const grant = JSON.parse(Buffer.from(A.voice.token.split('.')[1], 'base64url')).video;
  if (grant.room !== 'dp-' + code) fail('voice is not one room for the whole table: ' + grant.room);
  // A fifth person joins a full table and watches without seeing any hand.
  const E = phone('E', { idle: true }); await E.open;
  E.send({ t: 'hello', pid: 'test-pid-E-xxxx', name: 'PE', icon: '🐼' }); await sleep(50);
  E.send({ t: 'join', code }); await sleep(250);
  if (!E.state || E.state.me !== -1) fail('watcher not seated as watcher');
  if (E.state.game && E.state.game.hand.length) fail('watcher can see a hand');
  if (!A.state.watchers.includes('PE')) fail('players do not see the watcher');
  E.send({ t: 'sit' }); await sleep(100);
  if (!E.errors.some(x => /khali/.test(x))) fail('watcher sat on a full table');
  // C leaves mid-table: a bot takes the seat, then the watcher takes it from the bot.
  C.send({ t: 'leave' }); await sleep(150);
  E.send({ t: 'sit' }); await sleep(200);
  if (E.state.me < 0) fail('watcher could not take the bot seat');
  E.idle = false;
  // D never plays: their turns must time out and auto-play the highest card.
  const t0 = Date.now();
  while (A.state.phase !== 'final' && Date.now() - t0 < 60000) await sleep(100);
  if (A.state.phase !== 'final') fail('table did not finish, phase=' + A.state.phase);
  const T = A.state.table;
  const autos = A.events.filter(e => e.t === 'auto').length;
  const tensOk = T.history.every(h => h.a + h.b === 4);
  if (!tensOk) fail('tens do not add to 4: ' + JSON.stringify(T.history));
  if (T.dehle[0] + T.dehle[1] !== 4 * T.played) fail('dehle total wrong');
  if (!autos) fail('no auto-plays for idle player');
  if (A.state.prompt === null && !A.events.length) fail('no events');
  // Kot rule: replay history and compare
  let K = { holder: null, n: 0 };
  for (const h of T.history) if (h.kotTo !== null) { if (K.holder === null || K.holder === h.kotTo) { K.holder = h.kotTo; K.n++; } else { K.n--; if (!K.n) K.holder = null; } }
  if (K.holder !== T.kot.holder || K.n !== T.kot.n) fail('kot mismatch');
  // reconnect: B drops and comes back
  B.ws.close(); await sleep(100);
  const B2 = phone('B'); await B2.open; B2.send({ t: 'hello', pid: 'test-pid-B-xxxx', name: 'PB', icon: '🐯' }); await sleep(150);
  if (!B2.state || B2.state.me !== B.state.me) fail('reconnect did not restore seat');
  // privacy: no other hands in any state
  if (JSON.stringify(A.state).includes('"hands"')) fail('hands leaked');
  console.log('PASS', { games: T.played, history: T.history, kot: T.kot, dehle: T.dehle, autoPlays: autos, host: A.state.host, teamNames: A.state.teamNames });
  srv.kill(); process.exit(0);
})().catch(e => fail(e.stack));
