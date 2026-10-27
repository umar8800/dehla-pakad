// Tournaments: a lobby where friends form teams of 2, a league, then
// semi-finals (or a straight final with 3 teams). Each match is a locked Room.
const { Room } = require('./room');
const db = require('./db');

const TEAM_PRESETS = ['Manik Bagh Mandali', 'Badwali Chowki Badshahs', 'Khajrana Kings', 'Rajwada Royals', 'Thanos Ki Sena', 'Wakanda Warriors',
  'Super Saiyan Squad', 'Titan Slayers', 'Meme Mafia', 'Hogwarts Ke Sher', 'Dehla Dacoits', 'Kot Killers', 'Turup Ke Badshah', 'Begum Ke Bodyguards',
  'Desi Dons', 'Toofani Tigers', 'Desi Daredevils', 'Baazigar Boys', 'Chai Champions', 'Ludo Legends', 'Nukkad Ninjas'];
const BOT_NAMES = ['Zara', 'Imran', 'Bilal', 'Ayesha', 'Hamza', 'Sana', 'Faisal', 'Noor', 'Danish', 'Hira', 'Kabir', 'Mehak'];
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const MIN_TEAMS = 3, MAX_TEAMS = 16;

function roundRobin(n) {
  const a = [...Array(n).keys()]; if (n % 2) a.push(null);
  const m = a.length, rounds = [];
  for (let r = 0; r < m - 1; r++) {
    const pairs = [];
    for (let i = 0; i < m / 2; i++) { const x = a[i], y = a[m - 1 - i]; if (x !== null && y !== null) pairs.push([x, y]); }
    rounds.push(pairs); a.splice(1, 0, a.pop());
  }
  return rounds;
}

class Tournament {
  constructor(code, hostPid, deps) {
    this.code = code;
    this.hostPid = hostPid;
    this.deps = deps;                 // { rooms, newCode, onEmpty, roomGone }
    this.settings = { gpm: 2, perTeam: 6, prize: '₹500 Amazon voucher' };
    this.phase = 'lobby';
    this.players = [];                // { id, pid, name, icon, ws, connected, team, want, bot }
    this.teams = [];                  // { idx, name, ids: [id, id] }
    this.matches = [];
    this.champion = null;
    this.claims = [];
    this.watchers = new Map();
    this.nextId = 1;
    this.createdAt = Date.now();
    this.timers = {};
  }

  // ---------- people ----------
  byPid(pid) { return this.players.find(p => !p.bot && p.pid === pid); }
  byId(id) { return this.players.find(p => p.id === id); }
  teamOf(p) { return p && p.team !== null && p.team !== undefined ? this.teams[p.team] : null; }

  join(client) {
    let p = this.byPid(client.pid);
    if (p) Object.assign(p, { ws: client.ws, connected: true, name: client.name, icon: client.icon });
    else if (this.phase === 'lobby') {
      if (this.players.filter(x => !x.bot).length >= MAX_TEAMS * 2) return 'Tournament bhar gaya hai';
      p = { id: this.nextId++, pid: client.pid, name: client.name, icon: client.icon, ws: client.ws, connected: true, team: null, want: null, bot: false };
      this.players.push(p);
    } else {
      this.watchers.set(client.pid, client.ws);
    }
    clearTimeout(this.timers.empty);
    this.broadcast();
    return null;
  }

  disconnect(pid) {
    this.watchers.delete(pid);
    const p = this.byPid(pid);
    if (!p) return;
    p.connected = false; p.ws = null;
    if (this.phase === 'lobby') return this.leave(pid);
    this.broadcast();
    this.checkEmpty();
  }

  leave(pid) {
    this.watchers.delete(pid);
    const p = this.byPid(pid);
    if (!p) return;
    if (this.phase === 'lobby') {
      this.breakTeam(p);
      this.players = this.players.filter(x => x !== p);
      this.players.forEach(x => { if (x.want === p.id) x.want = null; });
      if (this.hostPid === pid) { const h = this.players.find(x => !x.bot && x.connected); this.hostPid = h ? h.pid : null; }
    } else { p.ws = null; p.connected = false; }
    this.broadcast();
    this.checkEmpty();
  }

  checkEmpty() {
    if (this.players.some(p => !p.bot && p.connected) || this.watchers.size) return;
    clearTimeout(this.timers.empty);
    const wait = this.phase === 'lobby' ? 10 * 60_000 : this.phase === 'done' ? 30 * 60_000 : 6 * 3600_000;
    this.timers.empty = setTimeout(() => { if (!this.players.some(p => !p.bot && p.connected)) this.close(); }, wait);
  }

  close() {
    Object.values(this.timers).forEach(t => clearTimeout(t));
    clearInterval(this.timers.tick);
    db.deleteSnapshot('tour', this.code);
    this.deps.onEmpty(this.code);
  }

  // ---------- team building (lobby) ----------
  freeName() { const used = this.teams.map(t => t.name); return shuffle(TEAM_PRESETS).find(n => !used.includes(n)) || `Team ${this.teams.length + 1}`; }

  makeTeam(a, b) {
    const t = { idx: this.teams.length, name: this.freeName(), ids: [a.id, b.id] };
    this.teams.push(t); a.team = t.idx; b.team = t.idx; a.want = b.want = null;
    return t;
  }

  breakTeam(p) {
    const t = this.teamOf(p);
    if (!t) return;
    for (const id of t.ids) { const q = this.byId(id); if (q) q.team = null; }
    this.players = this.players.filter(q => !(q.bot && t.ids.includes(q.id)));   // bot partners go away
    this.teams.splice(t.idx, 1);
    this.teams.forEach((x, i) => { x.idx = i; x.ids.forEach(id => { const q = this.byId(id); if (q) q.team = i; }); });
  }

  act(pid, m) {
    const me = this.byPid(pid), host = pid === this.hostPid;
    if (m.a === 'claim') return this.claim(me, m.email);
    if (m.a === 'teamName') {
      const t = this.teams[m.team];
      if (!t) return;
      if (!host && !(me && t.ids.includes(me.id))) return 'Sirf apni team ka naam badal sakte ho';
      const name = String(m.name || '').trim().slice(0, 28);
      if (name) t.name = name;
      return this.broadcast();
    }
    if (this.phase !== 'lobby') return 'Tournament shuru ho chuka hai';
    if (!me) return;
    if (m.a === 'pick') {                     // choose a partner; a team forms when both choose each other
      const other = this.byId(m.id);
      if (!other || other === me || other.bot) return;
      if (me.team !== null || other.team !== null) return 'Pehle se team mein hai';
      if (other.want === me.id) this.makeTeam(me, other);
      else me.want = me.want === other.id ? null : other.id;
      return this.broadcast();
    }
    if (m.a === 'leaveTeam') { this.breakTeam(me); return this.broadcast(); }
    if (!host) return 'Ye sirf host kar sakta hai';
    if (m.a === 'randomize') {
      while (this.teams.length) this.breakTeam(this.byId(this.teams[0].ids[0]));
      const humans = shuffle(this.players.filter(p => !p.bot));
      for (let i = 0; i + 1 < humans.length; i += 2) this.makeTeam(humans[i], humans[i + 1]);
    } else if (m.a === 'swap') {              // trade two players between teams
      const a = this.byId(m.x), b = this.byId(m.y);
      if (!a || !b || a === b) return;
      const ta = this.teamOf(a), tb = this.teamOf(b);
      if (ta) ta.ids[ta.ids.indexOf(a.id)] = b.id;
      if (tb) tb.ids[tb.ids.indexOf(b.id)] = a.id;
      [a.team, b.team] = [b.team, a.team];
    } else if (m.a === 'botTeam') {
      if (this.teams.length >= 12) return 'Bas, 12 teams kaafi hain';
      const mk = () => { const used = this.players.map(x => x.name); const b = { id: this.nextId++, pid: null, name: shuffle(BOT_NAMES).find(n => !used.includes(n)) || 'Bot', icon: '🤖', ws: null, connected: true, team: null, want: null, bot: true }; this.players.push(b); return b; };
      this.makeTeam(mk(), mk());
    } else if (m.a === 'removeTeam') {
      const t = this.teams[m.team];
      if (!t || !t.ids.every(id => { const q = this.byId(id); return q && q.bot; })) return;
      this.breakTeam(this.byId(t.ids[0]));
    } else if (m.a === 'botPartner') {
      const p = this.byId(m.id);
      if (!p || p.team !== null) return;
      const used = this.players.map(x => x.name);
      const bot = { id: this.nextId++, pid: null, name: shuffle(BOT_NAMES).find(n => !used.includes(n)) || 'Bot', icon: '🤖', ws: null, connected: true, team: null, want: null, bot: true };
      this.players.push(bot);
      this.makeTeam(p, bot);
    } else if (m.a === 'settings') {
      const s = m.settings || {};
      if ([1, 2, 3, 6, 8].includes(s.gpm)) this.settings.gpm = s.gpm;
      if ([6, 7, 8].includes(s.perTeam)) this.settings.perTeam = s.perTeam;
      if (typeof s.prize === 'string') this.settings.prize = s.prize.trim().slice(0, 40);
    } else if (m.a === 'start') {
      const solo = this.players.filter(p => !p.bot && p.team === null);
      if (solo.length) return `${solo.map(p => p.name).join(', ')} ki team nahi bani. Partner do ya bot partner bithao.`;
      if (this.teams.length < MIN_TEAMS) return `Kam se kam ${MIN_TEAMS} teams chahiye`;
      this.start();
    }
    this.broadcast();
  }

  // ---------- schedule ----------
  start() {
    const n = this.teams.length, rr = roundRobin(n), rounds = [];
    if (n === 3) rounds.push(...rr, ...rr);    // 3 teams: every pair plays twice
    else {
      const count = Array(n).fill(0);
      for (let i = 0; Math.min(...count) < this.settings.perTeam && i < 400; i++) {
        const r = rr[i % rr.length]; rounds.push(r); r.forEach(([a, b]) => { count[a]++; count[b]++; });
      }
    }
    let id = 0;
    this.matches = rounds.flatMap((pairs, ri) => pairs.map(([a, b]) => this.newMatch(id++, a, b, 'league', ri + 1)));
    this.phase = 'league';
    this.startedAt = Date.now();
    this.tick();
  }

  newMatch(id, a, b, stage, round) {
    return { id, a, b, stage, round, status: 'waiting', gameNo: 0, games: this.settings.gpm, pts: [0, 0], kots: [0, 0], dehle: [0, 0], haath: [0, 0], winner: null, note: '', roomCode: null };
  }

  stageMatches() { return this.matches.filter(m => m.stage === (this.phase === 'league' ? 'league' : this.phase)); }
  busy(t) { return this.matches.some(m => (m.status === 'live' || m.status === 'ready') && (m.a === t || m.b === t)); }

  tick() {
    if (!['league', 'semi', 'final'].includes(this.phase)) return;
    for (const m of this.stageMatches()) {
      if (m.status !== 'waiting' || this.busy(m.a) || this.busy(m.b)) continue;
      this.startMatch(m);
    }
    this.broadcast();
  }

  startMatch(m) {
    const A = this.teams[m.a], B = this.teams[m.b];
    const seat = id => { const p = this.byId(id); return p.bot ? { bot: true, name: p.name, icon: p.icon } : { pid: p.pid, name: p.name, icon: p.icon }; };
    const code = this.deps.newCode();
    const room = new Room(code, c => this.deps.roomGone(c), {
      tourCode: this.code, matchId: m.id, stage: m.stage, round: m.round, games: this.settings.gpm, knockout: m.stage !== 'league',
      teamNames: [A.name, B.name], seats: [seat(A.ids[0]), seat(B.ids[0]), seat(A.ids[1]), seat(B.ids[1])],
    });
    this.hook(room, m);
    this.deps.rooms.set(code, room);
    m.status = 'ready'; m.roomCode = code; m.readyAt = Date.now();
    // Tell the four players their match is ready.
    for (const id of [...A.ids, ...B.ids]) { const p = this.byId(id); if (p && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'tourMatch', code, tour: this.code })); }
    // A match with no humans connected at all plays itself out with bots.
    if (![...A.ids, ...B.ids].some(id => { const p = this.byId(id); return p && !p.bot; })) room.startTable();
  }

  hook(room, m) {
    room.hooks = {
      onUpdate: r => { this.copyMatch(m, r); this.broadcast(); },
      onEnd: r => { this.copyMatch(m, r); this.matchDone(m); },
    };
  }

  copyMatch(m, r) {
    const T = r.table;
    if (!T) return;
    const M = T.match;
    Object.assign(m, { status: r.phase === 'final' ? 'done' : 'live', gameNo: T.played, games: M.games, pts: M.pts.slice(), kots: M.kots.slice(), dehle: T.dehle.slice(), haath: M.haath.slice(), note: M.note });
    if (r.phase === 'final') m.winner = M.winner === null ? null : (M.winner === 0 ? m.a : m.b);
  }

  matchDone(m) {
    m.status = 'done';
    this.advance();
    this.tick();
  }

  // ---------- standings ----------
  standings() {
    const S = this.teams.map(t => ({ t: t.idx, played: 0, pts: 0, kots: 0, dehle: 0, haath: 0, h2h: {} }));
    for (const m of this.matches) {
      if (m.stage !== 'league' || m.status !== 'done') continue;
      [[m.a, 0, m.b], [m.b, 1, m.a]].forEach(([t, i, o]) => {
        const s = S[t]; s.played++; s.pts += m.pts[i]; s.kots += m.kots[i]; s.dehle += m.dehle[i]; s.haath += m.haath[i];
        s.h2h[o] = (s.h2h[o] || 0) + m.pts[i] - m.pts[1 - i];
      });
    }
    return S.sort((x, y) => y.pts - x.pts || x.kots - y.kots || y.dehle - x.dehle || y.haath - x.haath || (y.h2h[x.t] || 0) - (x.h2h[y.t] || 0));
  }

  advance() {
    const cur = this.stageMatches();
    if (!cur.length || cur.some(m => m.status !== 'done')) return;
    let id = this.matches.length;
    if (this.phase === 'league') {
      const S = this.standings();
      if (this.teams.length >= 4) { this.matches.push(this.newMatch(id++, S[0].t, S[3].t, 'semi', 1), this.newMatch(id++, S[1].t, S[2].t, 'semi', 1)); this.phase = 'semi'; }
      else { this.matches.push(this.newMatch(id++, S[0].t, S[1].t, 'final', 1)); this.phase = 'final'; }
    } else if (this.phase === 'semi') {
      const w = cur.map(m => m.winner);
      this.matches.push(this.newMatch(id++, w[0], w[1], 'final', 1)); this.phase = 'final';
    } else if (this.phase === 'final') {
      const f = cur[0];
      this.phase = 'done'; this.champion = f.winner;
      this.finishedAt = Date.now();
      const humansOf = t => this.teams[t].ids.map(i => this.byId(i)).filter(p => p && !p.bot);
      const rows = this.players.filter(p => !p.bot).map(p => ({ pid: p.pid, tours: 1 }));
      rows.forEach(r => {
        const p = this.byPid(r.pid);
        if (p.team === f.a || p.team === f.b) r.finals = 1;
        if (p.team === this.champion) r.tw = 1;
      });
      db.bumpStats(rows);
      const C = this.teams[this.champion];
      db.insertTournament({ code: this.code, host_pid: this.hostPid, prize: this.settings.prize, champion: { name: C.name, players: humansOf(this.champion).map(p => p.name) }, data: this.publicData() });
      this.checkEmpty();
    }
  }

  claim(me, email) {
    if (this.phase !== 'done' || !me || me.team !== this.champion) return 'Sirf jeetne wali team prize claim kar sakti hai';
    email = String(email || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return 'Email sahi nahi lag raha';
    this.claims = this.claims.filter(c => c.id !== me.id);
    this.claims.push({ id: me.id, name: me.name, email });
    db.insertClaim({ tour_code: this.code, pid: me.pid, name: me.name, email });
    this.broadcast();
  }

  // ---------- views ----------
  publicData() {
    return { teams: this.teams.map(t => ({ name: t.name, players: t.ids.map(i => this.byId(i)).filter(Boolean).map(p => p.name) })), matches: this.matches, settings: this.settings };
  }

  view(pid) {
    const me = this.byPid(pid), host = pid === this.hostPid;
    const icon = p => (p.icon || '').startsWith('img:') ? '🙂' : p.icon;
    const hostP = this.byPid(this.hostPid);
    return {
      t: 'tour', code: this.code, phase: this.phase, isHost: host, hostName: hostP ? hostP.name : '', settings: this.settings,
      meId: me ? me.id : null, myTeam: me && me.team !== null ? me.team : -1, watching: !me,
      players: this.players.map(p => ({ id: p.id, name: p.name, icon: icon(p), team: p.team, want: p.want, bot: p.bot, connected: !!p.connected, you: !!me && p === me })),
      teams: this.teams.map(t => ({ idx: t.idx, name: t.name, ids: t.ids })),
      matches: this.matches.map(m => ({ ...m })),
      champion: this.champion, claimed: !!me && this.claims.some(c => c.id === me.id),
      claims: host ? this.claims.map(c => ({ name: c.name, email: c.email })) : null,
      watchers: this.watchers.size, voice: Room.voiceReady,
    };
  }

  broadcast() {
    if (this.timers.bc) return;                  // at most ~4 updates a second
    this.timers.bc = setTimeout(() => {
      this.timers.bc = null;
      for (const p of this.players) if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(this.view(p.pid)));
      if (this.watchers.size) { const v = JSON.stringify(this.view(null)); for (const ws of this.watchers.values()) if (ws.readyState === 1) ws.send(v); }
      db.saveSnapshot('tour', this.code, () => this.toJSON());
    }, 250);
  }

  // ---------- saving and restoring ----------
  toJSON() {
    return { code: this.code, hostPid: this.hostPid, settings: this.settings, phase: this.phase, teams: this.teams, matches: this.matches, champion: this.champion,
      claims: this.claims, nextId: this.nextId, createdAt: this.createdAt, startedAt: this.startedAt || 0,
      players: this.players.map(p => ({ id: p.id, pid: p.pid, name: p.name, icon: p.icon && p.icon.length > 60_000 ? '🙂' : p.icon, team: p.team, want: p.want, bot: p.bot })) };
  }

  static fromJSON(d, deps) {
    const t = new Tournament(d.code, d.hostPid, deps);
    Object.assign(t, { settings: d.settings, phase: d.phase, teams: d.teams, matches: d.matches, champion: d.champion, claims: d.claims || [], nextId: d.nextId, createdAt: d.createdAt, startedAt: d.startedAt });
    t.players = d.players.map(p => ({ ...p, ws: null, connected: !!p.bot }));
    return t;
  }
}

module.exports = { Tournament, roundRobin };
