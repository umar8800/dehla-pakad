// Dehla Pakad server: serves the app and runs friends tables and tournaments over WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');
const { Tournament } = require('./tournament');
const db = require('./db');
const fcode = require('./fcode');
const crypto = require('crypto');
// 4-digit PINs are hashed with a per-player salt; 5 wrong tries lock that username for 10 minutes.
const hashPin = pin => { const salt = crypto.randomBytes(8).toString('hex'); return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex'); };
const checkPin = (pin, stored) => { const [salt, h] = stored.split(':'); try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pin, salt, 32)); } catch { return false; } };
const fails = new Map();
// Simple sliding-window counter: returns false once `max` hits happen inside `ms`.
function limit(map, key, max, ms) {
  const now = Date.now(), arr = (map.get(key) || []).filter(t => now - t < ms);
  if (arr.length >= max) { map.set(key, arr); return false; }
  arr.push(now); map.set(key, arr); return true;
}
// ---- admin email codes ----
const RESEND_KEY = (process.env.RESEND_API_KEY || '').trim();
const adminCodes = new Map();      // pid -> { hash, exp, tries }
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const maskEmail = e => e ? e.replace(/^(.)(.*)(.@.*)$/, (_, a, b, c) => a + '•'.repeat(Math.min(6, b.length)) + c) : null;
async function sendAdminEmail(to, code) {
  const res = await fetch(process.env.RESEND_URL || 'https://api.resend.com/emails', {   // RESEND_URL only for tests
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json', 'user-agent': 'dehla-pakad-server' },
    body: JSON.stringify({ from: 'Dehla Pakad <onboarding@resend.dev>', to: [to], subject: `Dehla Pakad admin code: ${code}`,
      html: `<div style="font-family:system-ui,sans-serif;font-size:16px"><p>Tumhara admin login code:</p><p style="font-size:32px;font-weight:800;letter-spacing:6px">${code}</p><p>Ye code 10 minute tak chalega. Agar tumne login nahi kiya, toh is email ko ignore karo.</p></div>` }),
  });
  if (!res.ok) throw new Error(`email ${res.status} ${(await res.text()).slice(0, 160)}`);
}
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

// Voice chat (LiveKit). Switched on only when all three keys are set on the server.
const LK = { url: process.env.LIVEKIT_URL, key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET };
const LKT = () => ({ url: LK.url.trim(), key: LK.key.trim(), secret: LK.secret.trim() });   // tolerate stray spaces/newlines
Room.voiceReady = !!(LK.url && LK.key && LK.secret);
Room.voiceCount = name => (typeof voiceNow !== 'undefined' && voiceNow.get(name)) || 0;
const LK_CLIENT = path.join(__dirname, '..', 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const rooms = new Map();   // code -> Room (friends tables and tournament matches)
const tours = new Map();   // code -> Tournament
const clients = new Set();
const online = new Map();  // pid -> client (latest connection)

// ---- static files: kept in memory, gzipped, with ETags so repeat visits cost almost nothing ----
const zlib = require('zlib');
const fileCache = new Map();   // key -> { body, gz, etag, type }
function cached(key, load, type) {
  let c = fileCache.get(key);
  if (!c || process.env.NODE_ENV !== 'production') {
    const body = load();
    c = { body, gz: zlib.gzipSync(body, { level: 9 }), etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"', type };
    fileCache.set(key, c);
  }
  return c;
}
const USAGE = { http: 0, ws: 0, voice: 0, mic: 0, peak: 0, codes: 0, users: new Map() };   // flushed to the database every minute
function serve(req, res, c, cacheControl) {
  const head = { 'content-type': c.type, 'cache-control': cacheControl, etag: c.etag, vary: 'accept-encoding' };
  if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, head); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && !/^(image|font)\//.test(c.type);
  const body = gz ? c.gz : c.body;
  if (gz) head['content-encoding'] = 'gzip';
  head['content-length'] = body.length;
  USAGE.http += body.length;
  res.writeHead(200, head); res.end(body);
}
const HOSTS = new Set(['dehlapakad.com', 'www.dehlapakad.com', 'dehla-pakad-z5re.onrender.com']);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`ok ${rooms.size} tables · ${tours.size} tournaments · voice ${Room.voiceReady ? 'on' : 'off'} · db ${db.enabled ? 'on' : 'off'}`); }
  if (url.pathname === '/vendor/livekit-client.js') return serve(req, res, cached('lk', () => fs.readFileSync(LK_CLIENT), 'text/javascript'), 'public, max-age=604800');
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  if (file.endsWith('index.html')) {               // fill in the site address for WhatsApp link previews
    const host = HOSTS.has(String(req.headers.host)) ? req.headers.host : 'dehlapakad.com';
    return serve(req, res, cached('index:' + host, () => Buffer.from(fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(/%ORIGIN%/g, `https://${host}`)), TYPES['.html']), 'no-cache');
  }
  serve(req, res, cached(file, () => fs.readFileSync(file), TYPES[ext] || 'application/octet-stream'), file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=86400');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024, perMessageDeflate: { threshold: 512, zlibDeflateOptions: { level: 6 } } });

function newCode() {
  for (let i = 0; i < 80; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c) && !tours.has(c)) return c;
  }
  return String(Date.now()).slice(-6);
}
const roomGone = c => rooms.delete(c);
const tourDeps = { rooms, newCode, roomGone, onEmpty: c => tours.delete(c) };

function cleanProfile(m) {
  const name = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
  let icon = String(m.icon || '🙂');
  if (icon.startsWith('img:')) { if (icon.length > 40_000 || !icon.startsWith('img:data:image/')) icon = '🙂'; }
  else if (icon.startsWith('jer:')) { if (!/^jer:#[0-9a-fA-F]{6}:\d{0,2}$/.test(icon)) icon = '🏏'; }
  else icon = [...icon].slice(0, 4).join('');
  return { name, icon };
}

// ---------- rankings ----------
const rankIcon = i => !i || i.startsWith('img:') ? '🙂' : i;
const rankRow = (p, me) => ({ name: p.name, icon: rankIcon(p.icon), tw: p.tw, finals: p.finals, tours: p.tours, kg: p.kot_given, kt: p.kot_taken, games: p.games, me: p.pid === me });
async function rankings(pid) {
  const all = await db.allPlayers();
  const meRow = all.find(p => p.pid === pid);
  const friendsSet = new Set([pid, ...(meRow ? meRow.friends : [])]);
  return {
    t: 'rank', enabled: db.enabled, total: all.length,
    me: meRow ? { ...rankRow(meRow, pid), rank: all.indexOf(meRow) + 1, tablesW: meRow.tables_w, tablesP: meRow.tables_p, dehle: meRow.dehle } : null,
    global: all.slice(0, 30).map(p => rankRow(p, pid)),
    friends: all.filter(p => friendsSet.has(p.pid)).slice(0, 50).map(p => rankRow(p, pid)),
    shame: [...all].sort((a, b) => b.kot_taken - a.kot_taken || a.tw - b.tw).filter(p => p.kot_taken > 0).slice(0, 20).map(p => rankRow(p, pid)),
  };
}

// ---------- friends ----------
function whereJoinable(c) {
  if (c.room && !c.room.locked && c.room.phase === 'lobby') return { kind: 'table', code: c.room.code };
  if (c.tour && c.tour.phase === 'lobby') return { kind: 'tour', code: c.tour.code };
  return null;
}
async function friendsView(pid) {
  const [friends, played] = await Promise.all([db.friendsOf(pid), db.playedWith(pid)]);
  const ids = new Set(friends.map(f => f.pid));
  const row = p => { const o = online.get(p.pid); return { fc: p.fcode || fcode(p.pid), name: p.name, icon: rankIcon(p.icon), online: !!o, where: o ? whereJoinable(o) : null }; };
  return {
    t: 'friends', fc: fcode(pid),
    list: friends.map(row).sort((a, b) => b.online - a.online),
    suggest: played.filter(p => p.pid !== pid && !ids.has(p.pid)).slice(0, 12).map(row),
  };
}

wss.on('connection', (ws, req) => {
  const client = { ws, pid: null, name: 'Player', icon: '🙂', room: null, tour: null,
    ip: String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() };
  clients.add(client);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const err = text => send({ t: 'error', text });

  const queue = [];
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (client.authing) return queue.length < 50 && queue.push(m);   // wait for hello to finish
    handle(m);
  });
  const flush = () => { client.authing = false; while (queue.length && !client.authing) handle(queue.shift()); };

  async function hello(m) {
    if (typeof m.pid !== 'string' || m.pid.length < 8 || m.pid.length > 64) return err('Profile theek nahi hai');
    const acct = await db.accountOf(m.pid);
    if (!acct || !acct.username) {
      // Only test runs without a database may play without an account.
      if (db.enabled || m.needAccount) return send({ t: 'needAccount' });
    }
    client.pid = m.pid;
    Object.assign(client, cleanProfile(m));
    if (acct && acct.username) { client.name = acct.name; if (acct.icon && !m.icon) client.icon = acct.icon; }
    online.set(client.pid, client);
    if (acct && acct.username) db.setIcon(client.pid, client.icon); else db.upsertPlayer(client.pid, client.name, client.icon, fcode(client.pid));
    const admin = await db.isAdmin(client.pid);
    send({ t: 'me', name: client.name, username: acct ? acct.username : null, admin });
    if (!client.sessionId) {
      const ua = String(m.ua || '');
      const device = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Other';
      client.sessionId = await db.sessionStart(client.pid, device + (m.standalone ? ' · app' : ' · browser'));
    }
    // Rejoin the tournament and/or table this player was already part of.
      for (const t of tours.values()) if (t.byPid(client.pid)) { client.tour = t; t.join(client); break; }
      for (const r of rooms.values()) if (r.seatOf(client.pid) >= 0 && !(r.match && r.phase === 'final')) { client.room = r; r.join(client); return; }
    if (!client.tour) send({ t: 'hi' });
  }

  async function account(m) {
    const u = String(m.username || '').trim();
    const key = u.toLowerCase();
    if (!/^[A-Za-z0-9_]{3,14}$/.test(u)) return send({ t: 'authErr', text: 'Username 3–14 letters/numbers ka ho (space nahi)' });
    if (m.t === 'checkName') { const p = await db.findByUsername(key); return send({ t: 'nameFree', username: u, free: !p }); }
    if (!/^\d{4}$/.test(String(m.pin || ''))) return send({ t: 'authErr', text: 'PIN 4 numbers ka hona chahiye' });
    if (m.t === 'register') {
      const pid = 'p' + crypto.randomBytes(12).toString('hex');
      const icon = cleanProfile(m).icon;
      const ok = await db.createAccount({ pid, username: key, name: u, icon, pin_hash: hashPin(String(m.pin)), fcode: fcode(pid) });
      if (!ok) return send({ t: 'authErr', text: `"${u}" pehle se kisi ka hai. Doosra username chuno.` });
      return send({ t: 'account', pid, name: u, icon });
    }
    // login: max 20 tries per network address per 10 minutes, plus a per-account lock stored in the database
    if (!limit(fails, 'ip:' + client.ip, 20, 10 * 60_000)) return send({ t: 'authErr', text: 'Bahut zyada koshish. 10 minute baad try karo.' });
    const p = await db.findByUsername(key);
    if (p && p.pin_locked_until && new Date(p.pin_locked_until) > new Date()) {
      const mins = Math.ceil((new Date(p.pin_locked_until) - Date.now()) / 60000);
      return send({ t: 'authErr', text: `Bahut galat PIN. ${mins} minute baad try karo.` });
    }
    if (!p || !p.pin_hash || !checkPin(String(m.pin), p.pin_hash)) {
      if (p) {
        const n = (p.failed_pins || 0) + 1;
        const lockMin = n >= 15 ? 24 * 60 : n >= 10 ? 60 : n % 5 === 0 ? 15 : 0;   // 5 wrong = 15 min, 10 = 1 h, 15+ = 1 day
        await db.setPinFails(p.pid, n, lockMin ? new Date(Date.now() + lockMin * 60000).toISOString() : null);
      }
      return send({ t: 'authErr', text: p ? 'PIN galat hai' : `"${u}" naam ka koi player nahi mila` });
    }
    if (p.failed_pins) db.setPinFails(p.pid, 0, null);
    send({ t: 'account', pid: p.pid, name: p.name, icon: p.icon || '🙂' });
  }

  function handle(m) {
    if (m.t === 'hello') { client.authing = true; return hello(m).catch(e => { console.error('hello', e.message); err('Server error'); }).finally(flush); }
    if (m.t === 'register' || m.t === 'login' || m.t === 'checkName') return account(m).catch(e => { console.error('account', e.message); send({ t: 'authErr', text: 'Server error, dobara try karo' }); });
    if (!client.pid) return err('Pehle profile banao');
    const room = client.room, tour = client.tour;
    switch (m.t) {
      case 'create': {
        if (room) room.leave(client.pid);
        const code = newCode();
        const r = new Room(code, roomGone);
        rooms.set(code, r);
        client.room = r;
        r.join(client);
        return;
      }
      case 'join': {
        const code = String(m.code || '').replace(/\D/g, '');
        const r = rooms.get(code), t = tours.get(code);
        if (t) {
          if (tour && tour !== t) tour.leave(client.pid);
          const e = t.join(client);
          if (e) return err(e);
          client.tour = t;
          return;
        }
        if (!r) return err(`DP-${code || '????'} nahi mila. Code check karo.`);
        if (room && room !== r) room.leave(client.pid);
        const e = r.join(client);
        if (e) return err(e);
        client.room = r;
        return;
      }
      case 'leave':
        if (room) room.leave(client.pid);
        client.room = null;
        return send({ t: 'left', tour: !!client.tour });
      case 'host':
        if (room) { const e = room.hostAction(client.pid, m); if (e) err(e); }
        return;
      case 'play':
        if (room) {
          const i = room.seatOf(client.pid);
          const e = room.doPlay(i, m.id, 'human');
          if (e && e !== 'follow') err(e);
        }
        return;
      case 'sit':
        if (room) { const e = room.sit(client); if (e) err(e); }
        return;
      case 'voiceToken': {
        if (m.ctx === 'tour') {
          if (!tour || !Room.voiceReady) return err('Voice chat abhi band hai');
          const p = tour.byPid(client.pid);
          const at = new AccessToken(LKT().key, LKT().secret, { identity: p ? `tp-${p.id}` : `twatch-${client.pid.slice(0, 10)}`, name: client.name, ttl: '6h' });
          at.addGrant({ roomJoin: true, room: `dp-t${tour.code}`, canPublish: !!p, canSubscribe: true });
          at.toJwt().then(token => send({ t: 'voiceToken', url: LKT().url, token })).catch(() => err('Voice shuru nahi ho paya'));
          return;
        }
        if (!room || !Room.voiceReady || !room.settings.voice) return err('Voice chat abhi band hai');
        const seat = room.seatOf(client.pid), watching = room.watchers.has(client.pid);
        if (seat < 0 && !watching) return;
        // One channel for the whole table, so partners can't talk privately.
        const at = new AccessToken(LKT().key, LKT().secret, { identity: seat >= 0 ? `seat-${seat}` : `watch-${client.pid.slice(0, 10)}`, name: client.name, ttl: '6h' });
        at.addGrant({ roomJoin: true, room: `dp-${room.code}`, canPublish: seat >= 0, canSubscribe: true });
        at.toJwt().then(token => send({ t: 'voiceToken', url: LKT().url, token }))
          .catch(() => err('Voice shuru nahi ho paya'));
        return;
      }
      case 'ready':
        if (room) room.markReady(client.pid);
        return;
      case 'react': case 'say':
        if (room) room.social(client.pid, m);
        return;
      case 'profile':                                   // only the avatar can change; the name is the username
        client.icon = cleanProfile(m).icon;
        db.setIcon(client.pid, client.icon);
        if (room) { const i = room.seatOf(client.pid); if (i >= 0) { Object.assign(room.seats[i], { name: client.name, icon: client.icon }); room.sendAvatars(); room.broadcast(); } }
        if (tour) { const p = tour.byPid(client.pid); if (p) { p.name = client.name; p.icon = client.icon; tour.broadcast(); } }
        return;
      // ---------- tournaments ----------
      case 'tourCreate': {
        if (tour) tour.leave(client.pid);
        const code = newCode();
        const t = new Tournament(code, client.pid, tourDeps);
        tours.set(code, t);
        client.tour = t;
        t.join(client);
        if (m.settings) t.act(client.pid, { a: 'settings', settings: m.settings });
        if (m.practice) {                                // you + bot partner vs two bot teams
          const me = t.byPid(client.pid);
          t.act(client.pid, { a: 'botPartner', id: me.id });
          t.act(client.pid, { a: 'botTeam' }); t.act(client.pid, { a: 'botTeam' });
        }
        return;
      }
      case 'tour':
        if (tour) { const e = tour.act(client.pid, m); if (e) err(e); }
        return;
      case 'tourLeave':
        if (tour) tour.leave(client.pid);
        client.tour = null;
        return send({ t: 'tourLeft' });
      case 'adminUsage':
        db.adminInfo(client.pid).then(async info => {
          if (!info || !client.adminOk) return err('Ye sirf admin ke liye hai');
          const u = await db.usageData();
          const id = pid => pid ? fcode(pid) : null;
          send({ t: 'adminUsage', now: new Date().toISOString(),   // usage_daily.day is a plain date, safe everywhere voiceNow: [...voiceNow.values()].reduce((a, b) => a + b, 0),
            daily: u.daily, voice: u.voice.map(({ pid, ...x }) => ({ ...x, id: id(pid) })), dbBytes: u.dbBytes, emailOn: !!RESEND_KEY });
        }).catch(e => { console.error('adminUsage', e.message); err('Server error'); });
        return;
      case 'adminCode':                                 // email a one-time code / check it
        db.adminInfo(client.pid).then(async info => {
          if (!info) return err('Ye sirf admin ke liye hai');
          if (m.a === 'send') {
            if (!RESEND_KEY || !info.admin_email) return send({ t: 'adminAuth', need: true, email: maskEmail(info.admin_email), canEmail: false });
            if (!limit(fails, 'code:' + client.pid, 3, 15 * 60_000)) return send({ t: 'adminAuth', need: true, email: maskEmail(info.admin_email), canEmail: true, error: 'Bahut codes bhej diye. 15 minute baad try karo.' });
            const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
            adminCodes.set(client.pid, { hash: sha(code), exp: Date.now() + 10 * 60_000, tries: 0 });
            try { await sendAdminEmail(info.admin_email, code); USAGE.codes++; send({ t: 'adminAuth', need: true, sent: true, email: maskEmail(info.admin_email), canEmail: true }); }
            catch (e) { console.error('admin email', e.message); send({ t: 'adminAuth', need: true, email: maskEmail(info.admin_email), canEmail: true, error: 'Email nahi gaya. Thodi der baad try karo.' }); }
            return;
          }
          if (m.a === 'verify') {
            const c = adminCodes.get(client.pid), code = String(m.code || '').replace(/\D/g, '');
            const fail = text => send({ t: 'adminAuth', need: true, sent: !!c, email: maskEmail(info.admin_email), canEmail: !!RESEND_KEY, error: text });
            if (!c || Date.now() > c.exp) { adminCodes.delete(client.pid); return fail('Code expire ho gaya. Naya code bhejo.'); }
            if (++c.tries > 5) { adminCodes.delete(client.pid); return fail('Bahut galat koshish. Naya code bhejo.'); }
            if (code.length !== 6 || !crypto.timingSafeEqual(Buffer.from(sha(code)), Buffer.from(c.hash))) return fail('Code galat hai');
            adminCodes.delete(client.pid);
            const token = crypto.randomBytes(32).toString('hex');
            await db.adminDeviceAdd(sha(token), client.pid, String(m.device || '').slice(0, 60));
            client.adminOk = true;
            console.log(`admin verified on a new device for ${client.name}`);
            return send({ t: 'adminToken', token });
          }
          if (m.a === 'revoke') { await db.adminDevicesRevoke(client.pid); client.adminOk = false; return send({ t: 'adminAuth', need: true, revoked: true, email: maskEmail(info.admin_email), canEmail: !!RESEND_KEY }); }
        }).catch(e => { console.error('adminCode', e.message); err('Server error'); });
        return;
      case 'admin':                                     // owner-only dashboard data
        db.adminInfo(client.pid).then(async info => {
          if (!info) return err('Ye sirf admin ke liye hai');
          if (!client.adminOk && typeof m.token === 'string' && /^[0-9a-f]{64}$/.test(m.token) && await db.adminDeviceCheck(sha(m.token), client.pid)) client.adminOk = true;
          if (!client.adminOk) return send({ t: 'adminAuth', need: true, email: maskEmail(info.admin_email), canEmail: !!RESEND_KEY && !!info.admin_email, badToken: !!m.token });
          const days = Math.min(90, Math.max(1, Number(m.days) || 30));
          const d = await db.adminData(days);
          const live = [...clients].filter(c => c.pid).map(c => ({ pid: c.pid, where: c.room ? (c.room.match ? 'Tournament match' : 'Table') + ' DP-' + c.room.code + ' · ' + c.room.phase : c.tour ? 'Tournament DP-' + c.tour.code + ' · ' + c.tour.phase : 'Home' }));
          const uniq = new Map(); live.forEach(l => uniq.set(l.pid, l));
          // never send private login ids, only public friend codes
          const id = pid => pid ? fcode(pid) : null;
          // Postgres gives microsecond times ("...48.227091+00:00") that Safari can't parse: send plain ISO times
          const iso = t => { if (!t) return t; const d = new Date(t); return isNaN(d) ? t : d.toISOString(); };
          const fixT = (o, keys) => { keys.forEach(k => { if (o[k]) o[k] = iso(o[k]); }); return o; };
          d.players.forEach(p => fixT(p, ['created_at', 'updated_at']));
          d.sessions.forEach(x => fixT(x, ['started_at', 'last_at']));
          d.games.forEach(g => fixT(g, ['started_at', 'ended_at']));
          d.players = d.players.map(({ pid, friends, ...p }) => ({ ...p, id: id(pid), friends: (friends || []).map(id), icon: rankIcon(p.icon) }));
          d.sessions = d.sessions.map(({ pid, ...x }) => ({ ...x, id: id(pid) }));
          d.games = d.games.map(g => ({ ...g, players: (g.players || []).map(({ pid, ...x }) => ({ ...x, id: id(pid) })) }));
          console.log(`admin dashboard: ${d.players.length} players, ${d.sessions.length} visits, ${d.games.length} games (${days}d)`);
          send({ t: 'adminData', days, now: new Date().toISOString(), live: [...uniq.values()].map(l => ({ id: id(l.pid), where: l.where })), ...d,
            rooms: [...rooms.values()].map(r => ({ code: r.code, phase: r.phase, match: !!r.match, seats: r.seats.map(s => s && { name: s.name, bot: !!s.bot, on: !!s.connected }), watchers: r.watchers.size })),
            tours: [...tours.values()].map(t => ({ code: t.code, phase: t.phase, players: t.players.length })) });
        });
        return;
      case 'clientLog':                                 // errors from phones (voice etc.) for debugging
        console.log(`client[${client.name}] ${String(m.where || '').slice(0, 20)}: ${String(m.msg || '').slice(0, 300)} · ${String(m.ua || '').slice(0, 120)}`);
        return;
      case 'rank':
        rankings(client.pid).then(send);
        return;
      // ---------- friends ----------
      case 'friends':
        friendsView(client.pid).then(send);
        return;
      case 'friendAdd': {
        const fc = String(m.fc || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
        db.findByFcode(fc).then(async p => {
          if (!p) return err(`Code ${fc || '?'} wala player nahi mila`);
          if (p.pid === client.pid) return err('Ye toh tumhara apna code hai 🙂');
          await db.addFriend(client.pid, p.pid);
          send({ t: 'toast', text: `${p.name} ab tumhare dost hain 🤝` });
          send(await friendsView(client.pid));
          const o = online.get(p.pid);
          if (o) { o.ws.send(JSON.stringify({ t: 'toast', text: `${client.name} ne tumhe dost banaya 🤝` })); o.ws.send(JSON.stringify(await friendsView(p.pid))); }
        });
        return;
      }
      case 'friendRemove': {
        const fc = String(m.fc || '').toUpperCase();
        db.findByFcode(fc).then(async p => { if (p) await db.removeFriend(client.pid, p.pid); send(await friendsView(client.pid)); });
        return;
      }
      case 'invite': {                                  // in-app invite to a friend who is online
        const where = whereJoinable(client);
        if (!where) return err('Pehle table ya tournament lobby kholo');
        db.findByFcode(String(m.fc || '').toUpperCase()).then(p => {
          const o = p && online.get(p.pid);
          if (!o) return err(`${p ? p.name : 'Dost'} abhi online nahi hai. WhatsApp se bulao.`);
          o.ws.send(JSON.stringify({ t: 'invite', from: client.name, icon: rankIcon(client.icon), ...where }));
          send({ t: 'toast', text: `${p.name} ko invite bhej diya` });
        });
        return;
      }
    }
  }

  ws.on('close', () => {
    clients.delete(client);
    if (client.sessionId) db.sessionsTouch([client.sessionId]);
    if (client.pid && online.get(client.pid) === client) online.delete(client.pid);
    if (client.room && client.pid) client.room.disconnect(client.pid);
    if (client.tour && client.pid) client.tour.disconnect(client.pid);
  });
});

// Drop dead connections so a phone that lost signal shows as disconnected.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25_000);

// ---- usage meter: voice minutes straight from LiveKit, bandwidth from the sockets ----
const lkSvc = Room.voiceReady ? new RoomServiceClient(LKT().url.replace(/^ws/, 'http'), LKT().key, LKT().secret) : null;
const voiceNow = new Map();   // LiveKit room name -> people connected
function voicePid(roomName, identity) {
  const byPrefix = pfx => { for (const c of clients) if (c.pid && c.pid.startsWith(pfx)) return c.pid; return null; };
  if (roomName.startsWith('dp-t')) {
    const t = tours.get(roomName.slice(4));
    if (identity.startsWith('tp-')) { const p = t && t.players.find(x => String(x.id) === identity.slice(3)); return p ? p.pid : null; }
    return identity.startsWith('twatch-') ? byPrefix(identity.slice(7)) : null;
  }
  const r = rooms.get(roomName.slice(3));
  if (identity.startsWith('seat-')) { const s = r && r.seats[+identity.slice(5)]; return s && !s.bot ? s.pid : null; }
  return identity.startsWith('watch-') ? byPrefix(identity.slice(6)) : null;
}
async function meterVoice() {
  if (!lkSvc) return;
  try {
    const list = await lkSvc.listRooms();
    let total = 0; voiceNow.clear();
    for (const room of list) {
      const ps = await lkSvc.listParticipants(room.name);
      voiceNow.set(room.name, ps.length); total += ps.length;
      for (const p of ps) {
        const mic = (p.tracks || []).some(t => (t.type === 0 || t.type === 'AUDIO') && !t.muted) ? 1 : 0;
        USAGE.voice++; USAGE.mic += mic;
        const pid = voicePid(room.name, p.identity);
        if (pid) { const u = USAGE.users.get(pid) || { m: 0, mic: 0 }; u.m++; u.mic += mic; USAGE.users.set(pid, u); }
      }
    }
    USAGE.peak = Math.max(USAGE.peak, total);
  } catch (e) { console.error('voice meter', e.message); }
}
let wsBytesSeen = new WeakMap();
function meterSockets() {
  for (const ws of wss.clients) {
    const sock = ws._socket; if (!sock) continue;
    const prev = wsBytesSeen.get(sock) || 0, now = sock.bytesWritten || 0;
    USAGE.ws += Math.max(0, now - prev); wsBytesSeen.set(sock, now);
  }
}
async function flushUsage() {
  meterSockets();
  const day = new Date().toISOString().slice(0, 10);
  const users = [...USAGE.users].map(([pid, u]) => ({ pid, ...u }));
  const totals = { voice: USAGE.voice, mic: USAGE.mic, http: USAGE.http, ws: USAGE.ws, peak: USAGE.peak, codes: USAGE.codes };
  Object.assign(USAGE, { http: 0, ws: 0, voice: 0, mic: 0, peak: 0, codes: 0 }); USAGE.users = new Map();
  if (Object.values(totals).some(Boolean)) await db.bumpUsage(day, users, totals);
}
setInterval(() => { meterVoice().then(flushUsage).catch(e => console.error('usage', e.message)); }, Number(process.env.USAGE_MS) || 60_000);

// Keep the free Render server awake: it sleeps after 15 min without inbound traffic and sometimes fails
// to wake up again. A request to our own public address every 10 min counts as inbound traffic.
// One service running all month is ~744 h, inside Render's 750 free hours. Set KEEP_AWAKE=off to stop.
if (process.env.RENDER && process.env.KEEP_AWAKE !== 'off') {
  const self = `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'dehlapakad.com'}/healthz`;
  setInterval(() => fetch(self, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'dehla-pakad-keepawake' } })
    .catch(e => console.error('keep-awake', e.message)), 10 * 60_000);
  console.log('keep-awake on:', self);
}

// Keep open sessions' "last seen" fresh, so a server restart still leaves an accurate end time.
setInterval(() => db.sessionsTouch([...clients].map(c => c.sessionId).filter(Boolean)), 60_000);

// Start matches whose teams have become free.
setInterval(() => { for (const t of tours.values()) t.tick(); }, 3_000);

// Bring back tables and tournaments that were running before a restart.
async function restore() {
  if (!db.enabled) return;
  const day = 24 * 3600_000;
  for (const s of await db.loadSnapshots('tour')) {
    if (Date.now() - Date.parse(s.updated_at) > day) { db.deleteSnapshot('tour', s.code); continue; }
    try { const t = Tournament.fromJSON(s.state, tourDeps); tours.set(t.code, t); t.checkEmpty(); } catch (e) { console.error('restore tour', s.code, e.message); }
  }
  for (const s of await db.loadSnapshots('table')) {
    if (Date.now() - Date.parse(s.updated_at) > day) { db.deleteSnapshot('table', s.code); continue; }
    try {
      const r = Room.fromJSON(s.state, roomGone);
      if (!r) { db.deleteSnapshot('table', s.code); continue; }
      rooms.set(r.code, r);
      if (r.match) {
        const t = tours.get(r.match.tourCode), m = t && t.matches.find(x => x.id === r.match.matchId);
        if (m) t.hook(r, m);
      }
      r.resume();
    } catch (e) { console.error('restore table', s.code, e.message); }
  }
  console.log(`Restored ${rooms.size} tables and ${tours.size} tournaments`);
}

// Check the LiveKit keys once at startup so a wrong key/secret shows up in the logs.
async function checkVoice() {
  if (!Room.voiceReady) return;
  const trimmed = [LK.url, LK.key, LK.secret].some(v => v !== v.trim());
  try {
    await new RoomServiceClient(LK.url.trim().replace(/^ws/, 'http'), LK.key.trim(), LK.secret.trim()).listRooms();
    console.log(`LiveKit keys OK (${LK.url.trim()})${trimmed ? ' · note: spaces around a key were removed' : ''}`);
  } catch (e) {
    console.error(`LiveKit keys WRONG: ${e.message || e} · re-copy LIVEKIT_API_KEY and LIVEKIT_API_SECRET from the same LiveKit project as ${LK.url}`);
  }
}
// Never let a slow database keep the server from opening: start after restore, or after 10s at most.
Promise.race([restore().catch(e => console.error('restore', e.message)), new Promise(r => setTimeout(r, 10_000))]).finally(() => server.listen(PORT, () =>
  console.log(`Dehla Pakad listening on ${PORT} · voice ${Room.voiceReady ? 'ON' : 'OFF (LiveKit keys missing)'} · database ${db.enabled ? 'ON' : 'OFF (Supabase keys missing)'}`) || checkVoice()));
