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
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

// Voice chat (LiveKit). Switched on only when all three keys are set on the server.
const LK = { url: process.env.LIVEKIT_URL, key: process.env.LIVEKIT_API_KEY, secret: process.env.LIVEKIT_API_SECRET };
const LKT = () => ({ url: LK.url.trim(), key: LK.key.trim(), secret: LK.secret.trim() });   // tolerate stray spaces/newlines
Room.voiceReady = !!(LK.url && LK.key && LK.secret);
const LK_CLIENT = path.join(__dirname, '..', 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const rooms = new Map();   // code -> Room (friends tables and tournament matches)
const tours = new Map();   // code -> Tournament
const clients = new Set();
const online = new Map();  // pid -> client (latest connection)

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`ok ${rooms.size} tables · ${tours.size} tournaments · voice ${Room.voiceReady ? 'on' : 'off'} · db ${db.enabled ? 'on' : 'off'}`); }
  if (url.pathname === '/vendor/livekit-client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' });
    return fs.createReadStream(LK_CLIENT).pipe(res);
  }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  if (file.endsWith('index.html')) {               // fill in the site address for WhatsApp link previews
    const proto = req.headers['x-forwarded-proto'] || 'http';
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' });
    return res.end(INDEX().replace(/%ORIGIN%/g, `${proto}://${req.headers.host}`));
  }
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(file).pipe(res);
});

let indexCache = null;
const INDEX = () => (process.env.NODE_ENV === 'production' && indexCache) || (indexCache = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8'));
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

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

wss.on('connection', ws => {
  const client = { ws, pid: null, name: 'Player', icon: '🙂', room: null, tour: null };
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
    send({ t: 'me', name: client.name, username: acct ? acct.username : null });
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
    // login
    const lock = fails.get(key);
    if (lock && lock.n >= 5 && Date.now() - lock.at < 10 * 60_000) return send({ t: 'authErr', text: 'Bahut galat PIN. 10 minute baad try karo.' });
    const p = await db.findByUsername(key);
    if (!p || !p.pin_hash || !checkPin(String(m.pin), p.pin_hash)) {
      fails.set(key, { n: (lock && Date.now() - lock.at < 10 * 60_000 ? lock.n : 0) + 1, at: Date.now() });
      return send({ t: 'authErr', text: p ? 'PIN galat hai' : `"${u}" naam ka koi player nahi mila` });
    }
    fails.delete(key);
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
restore().finally(() => server.listen(PORT, () =>
  console.log(`Dehla Pakad listening on ${PORT} · voice ${Room.voiceReady ? 'ON' : 'OFF (LiveKit keys missing)'} · database ${db.enabled ? 'ON' : 'OFF (Supabase keys missing)'}`) || checkVoice()));
