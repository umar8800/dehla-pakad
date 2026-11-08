// Admin security: only the admin account, and only after an emailed code; trusted devices; revoke; PIN lockout.
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const PORT = 3994, MAILPORT = 3993;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastMail = null;
const mail = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { lastMail = { auth: req.headers.authorization, body: JSON.parse(b) }; res.end('{"id":"x"}'); }); }).listen(MAILPORT);
const srv = spawn('node', ['server/index.js'], { env: { ...process.env, PORT, SUPABASE_URL: '', LIVEKIT_URL: '', TEST_ADMIN: 'boss', TEST_ADMIN_EMAIL: 'boss@example.com', RESEND_API_KEY: 're_test', RESEND_URL: `http://localhost:${MAILPORT}/emails` }, stdio: ['ignore', 'ignore', 'inherit'] });
const fail = m => { console.error('FAIL:', m); srv.kill(); mail.close(); process.exit(1); };
function phone() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`), P = { msgs: [] };
  ws.on('message', d => P.msgs.push(JSON.parse(d)));
  P.send = o => ws.send(JSON.stringify(o)); P.last = t => [...P.msgs].reverse().find(m => m.t === t);
  P.open = new Promise(r => ws.on('open', r)); P.ws = ws; return P;
}
async function account(name, pin) {
  const P = phone(); await P.open;
  P.send({ t: 'register', username: name, pin }); await sleep(200);
  let a = P.last('account');
  if (!a) { P.send({ t: 'login', username: name, pin }); await sleep(200); a = P.last('account'); }
  P.send({ t: 'hello', pid: a.pid, name, icon: '🙂', needAccount: true }); await sleep(200);
  return { P, pid: a.pid };
}
(async () => {
  await sleep(600);
  const { P: X } = await account('mallory', '1111');
  X.send({ t: 'admin' }); await sleep(150);
  if (!X.msgs.some(m => m.t === 'error' && /admin/.test(m.text)) || X.last('adminData')) fail('non-admin got admin');
  X.send({ t: 'adminCode', a: 'send' }); await sleep(150);
  if (lastMail) fail('non-admin triggered an email');

  const { P: A, pid } = await account('boss', '4321');
  if (!A.last('me').admin) fail('admin flag missing');
  A.send({ t: 'admin' }); await sleep(150);
  if (A.last('adminData') || !A.last('adminAuth').need) fail('admin data without email code');
  A.send({ t: 'adminCode', a: 'send' }); await sleep(250);
  if (!lastMail || lastMail.body.to[0] !== 'boss@example.com' || lastMail.auth !== 'Bearer re_test') fail('code email not sent correctly');
  const code = lastMail.body.subject.match(/(\d{6})/)[1];
  A.send({ t: 'adminCode', a: 'verify', code: code === '000000' ? '111111' : '000000' }); await sleep(150);
  if (!/galat/.test(A.last('adminAuth').error || '')) fail('wrong code accepted');
  A.send({ t: 'adminCode', a: 'verify', code }); await sleep(200);
  const token = (A.last('adminToken') || {}).token; if (!token) fail('no device token');
  A.send({ t: 'admin', token }); await sleep(200);
  if (!A.last('adminData')) fail('no data after verify');
  if (JSON.stringify(A.last('adminData')).includes(pid)) fail('private id leaked to dashboard');
  // same code can't be reused
  A.send({ t: 'adminCode', a: 'verify', code }); await sleep(150);
  if (A.msgs.filter(m => m.t === 'adminToken').length !== 1) fail('code reused');

  // new phone: trusted token works, fake token doesn't
  const { P: A2 } = await account('boss', '4321');
  A2.send({ t: 'admin', token }); await sleep(200);
  if (!A2.last('adminData')) fail('trusted device token rejected');
  const { P: A3 } = await account('boss', '4321');
  A3.send({ t: 'admin', token: 'f'.repeat(64) }); await sleep(200);
  if (A3.last('adminData') || !A3.last('adminAuth').badToken) fail('fake token accepted');
  // stolen token is useless on another account
  X.send({ t: 'admin', token }); await sleep(150);
  if (X.last('adminData')) fail('token worked on another account');

  // revoke everywhere
  A.send({ t: 'adminCode', a: 'revoke' }); await sleep(200);
  const { P: A4 } = await account('boss', '4321');
  A4.send({ t: 'admin', token }); await sleep(200);
  if (A4.last('adminData')) fail('revoked token still works');

  // PIN lockout: 5 wrong locks even the right PIN
  const L = phone(); await L.open;
  for (let i = 0; i < 5; i++) { L.send({ t: 'login', username: 'boss', pin: '0000' }); await sleep(80); }
  L.send({ t: 'login', username: 'boss', pin: '4321' }); await sleep(200);
  if (!/minute baad/.test((L.last('authErr') || {}).text || '') || L.last('account')) fail('no PIN lockout');

  console.log('PASS admin security');
  srv.kill(); mail.close(); process.exit(0);
})().catch(e => fail(e.message));
