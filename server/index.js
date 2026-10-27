// Dehla Pakad server: serves the app and runs friends tables over WebSocket.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Room } = require('./room');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const rooms = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(`ok ${rooms.size} tables`); }
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (url.pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': TYPES[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(file).pipe(res);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-6);
}

function cleanProfile(m) {
  const name = String(m.name || 'Player').trim().slice(0, 14) || 'Player';
  let icon = String(m.icon || '🙂');
  if (icon.startsWith('img:')) { if (icon.length > 40_000 || !icon.startsWith('img:data:image/')) icon = '🙂'; }
  else if (icon.startsWith('jer:')) { if (!/^jer:#[0-9a-fA-F]{6}:\d{0,2}$/.test(icon)) icon = '🏏'; }
  else icon = [...icon].slice(0, 4).join('');
  return { name, icon };
}

wss.on('connection', ws => {
  const client = { ws, pid: null, name: 'Player', icon: '🙂', room: null };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const err = text => send({ t: 'error', text });

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') {
      if (typeof m.pid !== 'string' || m.pid.length < 8 || m.pid.length > 64) return err('Profile theek nahi hai');
      client.pid = m.pid;
      Object.assign(client, cleanProfile(m));
      // Rejoin the table this player was already sitting at, if any.
      for (const r of rooms.values()) if (r.seatOf(client.pid) >= 0) { client.room = r; r.join(client); return; }
      return send({ t: 'hi' });
    }
    if (!client.pid) return err('Pehle profile banao');
    const room = client.room;
    switch (m.t) {
      case 'create': {
        if (room) room.leave(client.pid);
        const code = newCode();
        const r = new Room(code, c => rooms.delete(c));
        rooms.set(code, r);
        client.room = r;
        r.join(client);
        return;
      }
      case 'join': {
        const code = String(m.code || '').replace(/\D/g, '');
        const r = rooms.get(code);
        if (!r) return err(`Table DP-${code || '????'} nahi mili. Code check karo.`);
        if (room && room !== r) room.leave(client.pid);
        const e = r.join(client);
        if (e) return err(e);
        client.room = r;
        return;
      }
      case 'leave':
        if (room) room.leave(client.pid);
        client.room = null;
        return send({ t: 'left' });
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
      case 'ready':
        if (room) room.markReady(client.pid);
        return;
      case 'react': case 'say':
        if (room) room.social(client.pid, m);
        return;
      case 'profile':
        Object.assign(client, cleanProfile(m));
        if (room) { const i = room.seatOf(client.pid); if (i >= 0) { Object.assign(room.seats[i], { name: client.name, icon: client.icon }); room.sendAvatars(); room.broadcast(); } }
        return;
    }
  });

  ws.on('close', () => { if (client.room && client.pid) client.room.disconnect(client.pid); });
});

// Drop dead connections so a phone that lost signal shows as disconnected.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 25_000);

server.listen(PORT, () => console.log(`Dehla Pakad listening on ${PORT}`));
