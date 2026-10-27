// Accounts: unique usernames with a 4-digit PIN, login on a new phone, lockout after wrong PINs.
const { spawn } = require('child_process');
const WebSocket = require('ws');
const PORT = 3995;
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, SUPABASE_URL: '', LIVEKIT_URL: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = m => { console.error('FAIL:', m); srv.kill(); process.exit(1); };
function phone() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const P = { msgs: [] };
  ws.on('message', d => P.msgs.push(JSON.parse(d)));
  P.send = o => ws.send(JSON.stringify(o));
  P.last = t => [...P.msgs].reverse().find(m => m.t === t);
  P.open = new Promise(r => ws.on('open', r));
  return P;
}
(async () => {
  await sleep(500);
  const A = phone(), B = phone();
  await Promise.all([A.open, B.open]);
  A.send({ t: 'hello', pid: 'p-unknown-123456', name: 'X', icon: '🙂', needAccount: true }); await sleep(150);
  if (!A.last('needAccount')) fail('unknown player should be asked to make an account');
  A.send({ t: 'register', username: 'a b', pin: '1234' }); await sleep(100);
  if (!A.last('authErr')) fail('bad username accepted');
  A.send({ t: 'register', username: 'Umar', pin: '12' }); await sleep(100);
  if (!/PIN/.test(A.last('authErr').text)) fail('bad pin accepted');
  A.send({ t: 'register', username: 'Umar', pin: '4321', icon: '🦁' }); await sleep(200);
  const acc = A.last('account'); if (!acc || acc.name !== 'Umar') fail('register failed');
  B.send({ t: 'checkName', username: 'umar' }); await sleep(100);
  if (B.last('nameFree').free) fail('umar should be taken (case-insensitive)');
  B.send({ t: 'register', username: 'UMAR', pin: '1111' }); await sleep(150);
  if (!/pehle se/.test(B.last('authErr').text)) fail('duplicate username allowed');
  B.send({ t: 'login', username: 'umar', pin: '0000' }); await sleep(150);
  if (!/galat/.test(B.last('authErr').text)) fail('wrong pin accepted');
  B.send({ t: 'login', username: 'Umar', pin: '4321' }); await sleep(150);
  if (B.last('account').pid !== acc.pid) fail('login gave a different player');
  A.send({ t: 'hello', pid: acc.pid, name: 'Hacker', icon: '🦁', needAccount: true }); await sleep(150);
  if (A.last('me').name !== 'Umar') fail('name must come from the account');
  for (let i = 0; i < 5; i++) { B.send({ t: 'login', username: 'umar', pin: '9999' }); await sleep(60); }
  B.send({ t: 'login', username: 'umar', pin: '4321' }); await sleep(150);
  if (!/10 minute/.test(B.last('authErr').text)) fail('no lockout after 5 wrong PINs');
  console.log('PASS accounts');
  srv.kill(); process.exit(0);
})().catch(e => fail(e.message));
