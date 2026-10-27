// Friends: add by code, see who is online and where, in-app invite to a lobby, remove.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 3996;
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, SUPABASE_URL: '', LIVEKIT_URL: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = m => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
function phone(n) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const P = { n, fr: null, state: null, invites: [], errors: [], toasts: [] };
  ws.on('message', d => { const m = JSON.parse(d);
    if (m.t === 'friends') P.fr = m; if (m.t === 'state') P.state = m; if (m.t === 'invite') P.invites.push(m);
    if (m.t === 'error') P.errors.push(m.text); if (m.t === 'toast') P.toasts.push(m.text); });
  P.send = o => ws.send(JSON.stringify(o));
  P.open = new Promise(r => ws.on('open', () => { P.send({ t: 'hello', pid: 'friend-pid-' + n + '-xxxx', name: n, icon: '🦊' }); r(); }));
  P.ws = ws; return P;
}
(async () => {
  await sleep(500);
  const A = phone('Umar'), B = phone('Asad');
  await Promise.all([A.open, B.open]); await sleep(150);
  A.send({ t: 'friends' }); B.send({ t: 'friends' }); await sleep(200);
  if (!/^[A-Z2-9]{6}$/.test(A.fr.fc)) fail('bad friend code ' + A.fr.fc);
  A.send({ t: 'friendAdd', fc: A.fr.fc }); await sleep(150);
  if (!A.errors.length) fail('could add yourself');
  A.send({ t: 'friendAdd', fc: B.fr.fc }); await sleep(300);
  if (A.fr.list.length !== 1 || A.fr.list[0].name !== 'Asad') fail('A did not get B as friend');
  if (!B.fr || B.fr.list.length !== 1 || !B.toasts.length) fail('B was not told / did not get A');
  if (!A.fr.list[0].online) fail('B should show online');
  // invite needs a lobby
  A.send({ t: 'invite', fc: B.fr.fc }); await sleep(150);
  if (!A.errors.some(e => /lobby/.test(e))) fail('invite without lobby should fail');
  A.send({ t: 'create' }); await sleep(200);
  A.send({ t: 'invite', fc: B.fr.fc }); await sleep(200);
  if (B.invites.length !== 1 || B.invites[0].code !== A.state.code) fail('B did not get invite');
  B.send({ t: 'friends' }); await sleep(150);
  if (!B.fr.list[0].where || B.fr.list[0].where.code !== A.state.code) fail('B should see A in a lobby');
  if (!A.state.seats[0].fc) fail('seat should carry friend code');
  B.ws.close(); await sleep(200);
  A.send({ t: 'friends' }); await sleep(150);
  if (A.fr.list[0].online) fail('B should be offline');
  A.send({ t: 'friendRemove', fc: A.fr.list[0].fc }); await sleep(200);
  if (A.fr.list.length) fail('remove did not work');
  console.log('PASS', { code: A.fr.fc });
  srv.kill(); process.exit(0);
})().catch(e => fail(e.message));
