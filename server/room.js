// A table of 4: a friends table (lobby, Kot scoring) or a tournament match
// (fixed teams, points scoring). Also handles watchers, bots and reconnecting.
const { Game, team } = require('./engine');
const db = require('./db');

const TURN_MS = +process.env.TURN_MS || 60_000;          // each human turn
const RESOLVE_MS = +process.env.RESOLVE_MS || 1_500;    // pause to show a finished trick
const NEXT_GAME_MS = +process.env.NEXT_GAME_MS || 25_000; // next game starts even if not everyone taps
const MATCH_READY_MS = +process.env.MATCH_READY_MS || 120_000; // missing players get a bot after this
const BOT_NAMES = ['Zara', 'Imran', 'Bilal', 'Ayesha', 'Hamza', 'Sana', 'Faisal', 'Noor', 'Danish', 'Hira', 'Kabir', 'Mehak'];
const BOT_ICONS = ['🐯', '🦁', '🐼', '🦊', '🐵', '🦉', '🐸', '🐨', '🐺', '🐻'];
const pick = a => a[Math.floor(Math.random() * a.length)];

class Room {
  constructor(code, onEmpty, match = null) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.seats = [null, null, null, null];
    this.hostPid = null;
    this.teamNames = ['', ''];
    this.settings = { lengthType: 'games', games: 7, minutes: 30, showDehle: false, voice: true };
    this.watchers = new Map();   // pid -> { ws, name, icon }  people watching, not playing
    this.phase = 'lobby';
    this.table = null;
    this.game = null;
    this.result = null;
    this.ready = new Set();
    this.timers = {};
    this.deadline = 0;
    this.prompt = null;          // seat the host is asked to hand to a bot
    this.lastActive = Date.now();
    this.match = null;           // tournament match details, when this room is a match
    this.hooks = {};             // { onUpdate(room), onEnd(room) } for matches
    if (match) this.setupMatch(match);
  }

  get locked() { return !!this.match; }

  // ---------- tournament match ----------
  setupMatch(m) {
    this.match = { tourCode: m.tourCode, matchId: m.matchId, stage: m.stage, round: m.round, games: m.games, knockout: m.knockout };
    this.teamNames = m.teamNames.slice();
    this.seats = m.seats.map(s => s.bot ? { bot: true, name: s.name, icon: s.icon, connected: true, forPid: null }
      : { pid: s.pid, name: s.name, icon: s.icon, ws: null, connected: false, bot: false, timeouts: 0 });
    this.hostPid = null;
    this.settings = { ...this.settings, lengthType: 'games', games: m.games, voice: true };
    this.phase = 'ready';
    this.readyDeadline = Date.now() + MATCH_READY_MS;
    this.armReady();
  }

  armReady() {
    clearTimeout(this.timers.ready);
    this.timers.ready = setTimeout(() => {
      if (this.phase !== 'ready') return;
      this.seats.forEach((s, i) => { if (s && !s.bot && !s.connected) { this.seats[i] = this.makeBot(s.pid); this.event({ t: 'botIn', p: i }); } });
      this.startTable();
    }, Math.max(0, this.readyDeadline - Date.now()));
  }

  // ---------- people ----------
  humans() { return this.seats.filter(s => s && !s.bot); }
  seatOf(pid) { return this.seats.findIndex(s => s && !s.bot && s.pid === pid); }
  isHost(pid) { return !!pid && pid === this.hostPid; }

  join(client) {
    this.lastActive = Date.now();
    clearTimeout(this.timers.empty);
    let i = this.seatOf(client.pid);
    if (i >= 0) {                                    // coming back (or arriving for a match)
      Object.assign(this.seats[i], { ws: client.ws, connected: true, name: client.name, icon: client.icon });
      this.watchers.delete(client.pid);
      this.sendAvatars();
      this.broadcast();
      this.event({ t: 'back', p: i });
      if (this.phase === 'ready' && this.humans().every(s => s.connected)) this.startTable();
      return null;
    }
    if (!this.locked) {
      i = this.seats.findIndex(s => !s);
      if (i < 0 && this.phase !== 'lobby') {
        // A bot keeping a seat warm: the original player gets it back first, anyone else otherwise.
        i = this.seats.findIndex(s => s && s.bot && s.forPid === client.pid);
        if (i < 0) i = this.seats.findIndex(s => s && s.bot);
      }
    } else {
      // In a match only the player a bot replaced may take that seat back.
      i = this.seats.findIndex(s => s && s.bot && s.forPid === client.pid);
    }
    if (i < 0) {                                     // no seat: watch instead
      this.watchers.set(client.pid, { ws: client.ws, name: client.name, icon: client.icon });
      this.sendAvatars();
      this.broadcast();
      this.event({ t: 'watching', name: client.name });
      return null;
    }
    this.watchers.delete(client.pid);
    this.seats[i] = { pid: client.pid, name: client.name, icon: client.icon, ws: client.ws, connected: true, bot: false, timeouts: 0 };
    if (!this.hostPid && !this.locked) this.hostPid = client.pid;
    this.sendAvatars();
    this.broadcast();
    this.event({ t: 'joined', p: i });
    return null;
  }

  // A watcher takes an empty seat (lobby) or a bot's seat (during play).
  sit(client) {
    if (this.locked) return 'Tournament match mein bahar se seat nahi le sakte';
    if (!this.watchers.has(client.pid)) return 'Tum pehle se khel rahe ho';
    const free = this.seats.some(s => !s) || (this.phase !== 'lobby' && this.seats.some(s => s && s.bot));
    if (!free) return 'Abhi koi seat khali nahi';
    this.watchers.delete(client.pid);
    return this.join(client);
  }

  disconnect(pid) {
    if (this.watchers.has(pid)) { this.watchers.delete(pid); this.broadcast(); this.checkEmpty(); return; }
    const i = this.seatOf(pid);
    if (i < 0) return;
    const s = this.seats[i];
    s.connected = false; s.ws = null;
    if (this.phase === 'lobby') { this.leave(pid); return; }
    this.event({ t: 'gone', p: i });
    this.broadcast();
    this.checkEmpty();
  }

  leave(pid) {
    if (this.watchers.has(pid)) { this.watchers.delete(pid); this.broadcast(); this.checkEmpty(); return; }
    const i = this.seatOf(pid);
    if (i < 0) return;
    if (this.phase === 'final' || this.phase === 'ready') { this.seats[i].ws = null; this.seats[i].connected = false; this.broadcast(); this.checkEmpty(); return; }
    if (this.phase === 'lobby') this.seats[i] = null;
    else this.seats[i] = this.makeBot(pid);         // a bot finishes their games
    this.event({ t: 'left', p: i });
    if (this.hostPid === pid) {
      const h = this.humans().find(s => s.connected) || this.humans()[0];
      this.hostPid = h ? h.pid : null;
    }
    if (this.phase === 'play') this.schedule(); else this.broadcast();
    this.checkEmpty();
  }

  checkEmpty() {
    if (this.humans().some(s => s.connected) || this.watchers.size) return;
    clearTimeout(this.timers.empty);
    // Matches keep going with bots; friends tables wait 30 minutes for someone to come back.
    const wait = this.match && this.phase === 'final' ? 60_000 : this.match ? 3 * 3600_000 : 30 * 60_000;
    this.timers.empty = setTimeout(() => { if (!this.humans().some(s => s.connected) && !this.watchers.size) this.close(); }, wait);
  }

  close() {
    Object.values(this.timers).forEach(t => clearTimeout(t));
    db.deleteSnapshot('table', this.code);
    this.onEmpty(this.code);
  }

  makeBot(forPid) {
    const used = this.seats.filter(Boolean).map(s => s.name);
    return { bot: true, forPid: forPid || null, name: pick(BOT_NAMES.filter(n => !used.includes(n))) || 'Bot', icon: pick(BOT_ICONS), connected: true };
  }

  // ---------- lobby actions (host) ----------
  hostAction(pid, msg) {
    if (this.locked) return 'Tournament match mein ye nahi kar sakte';
    if (msg.a === 'teamName') {
      const t = msg.team === 1 ? 1 : 0, me = this.seatOf(pid);
      if (!this.isHost(pid) && (me < 0 || team(me) !== t)) return 'Sirf apni team ka naam badal sakte ho';
      this.teamNames[t] = String(msg.name || '').trim().slice(0, 28);
      return this.broadcast();
    }
    if (!this.isHost(pid)) return 'Ye sirf host kar sakta hai';
    if (msg.a === 'replaceBot') {
      const i = msg.seat;
      if (this.seats[i] && !this.seats[i].bot) { this.seats[i] = this.makeBot(this.seats[i].pid); this.prompt = null; this.event({ t: 'botIn', p: i }); this.schedule(); }
      else { this.prompt = null; this.broadcast(); }
      return;
    }
    if (msg.a === 'dismissPrompt') { this.prompt = null; return this.broadcast(); }
    if (this.phase === 'final' && msg.a === 'rematch') return this.startTable();
    if (this.phase !== 'lobby') return 'Table chal rahi hai';
    if (msg.a === 'swap') {
      const a = msg.x, b = msg.y;
      if (![a, b].every(n => Number.isInteger(n) && n >= 0 && n < 4)) return;
      [this.seats[a], this.seats[b]] = [this.seats[b], this.seats[a]];
    } else if (msg.a === 'randomize') {
      const filled = this.seats.slice();
      for (let i = 3; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [filled[i], filled[j]] = [filled[j], filled[i]]; }
      this.seats = filled;
    } else if (msg.a === 'addBot') {
      const i = this.seats.findIndex(s => !s);
      if (i >= 0) this.seats[i] = this.makeBot();
    } else if (msg.a === 'removeBot') {
      if (this.seats[msg.seat] && this.seats[msg.seat].bot) this.seats[msg.seat] = null;
    } else if (msg.a === 'settings') {
      const s = msg.settings || {};
      if (['games', 'time'].includes(s.lengthType)) this.settings.lengthType = s.lengthType;
      if ([5, 7, 11].includes(s.games)) this.settings.games = s.games;
      if ([5, 30, 60].includes(s.minutes)) this.settings.minutes = s.minutes;
      if (typeof s.showDehle === 'boolean') this.settings.showDehle = s.showDehle;
      if (typeof s.voice === 'boolean') this.settings.voice = s.voice;
    } else if (msg.a === 'start') {
      if (this.seats.some(s => !s)) return 'Pehle chaaron seats bharo';
      return this.startTable();
    }
    this.broadcast();
  }

  // ---------- table flow ----------
  startTable() {
    clearTimeout(this.timers.ready);
    this.table = { kot: { holder: null, n: 0 }, dehle: [0, 0], played: 0, start: Date.now(), dealer: 3, history: [] };
    if (this.match) this.table.match = { pts: [0, 0], kots: [0, 0], haath: [0, 0], games: this.match.games, winner: null, note: '' };
    this.newGame();
  }

  newGame() {
    this.table.dealer = (this.table.dealer + 1) % 4;
    this.game = new Game(this.table.dealer);
    this.phase = 'play';
    this.result = null;
    this.ready.clear();
    this.event({ t: 'newGame', no: this.table.played + 1 });
    this.schedule();
    if (this.hooks.onUpdate) this.hooks.onUpdate(this);
  }

  clearTurnTimers() { ['turn', 'bot', 'resolve'].forEach(k => clearTimeout(this.timers[k])); this.deadline = 0; }

  schedule() {
    this.clearTurnTimers();
    if (this.phase !== 'play') return this.broadcast();
    const g = this.game;
    if (g.resolving) {
      this.timers.resolve = setTimeout(() => {
        g.resolve(); this.flush();
        if (g.over) this.endGame(); else this.schedule();
      }, RESOLVE_MS);
      return this.broadcast();
    }
    const p = g.turn, s = this.seats[p];
    if (s.bot) {
      this.timers.bot = setTimeout(() => this.doPlay(p, g.botCard(p).id, 'bot'), (+process.env.BOT_MS || 700) + Math.random() * (+process.env.BOT_MS || 1100));
    } else {
      this.deadline = Date.now() + TURN_MS;
      this.timers.turn = setTimeout(() => this.timeout(p), TURN_MS);
    }
    this.broadcast();
  }

  timeout(p) {
    const g = this.game, s = this.seats[p];
    if (!g || g.turn !== p || g.resolving) return;
    const c = g.autoCard(p);
    this.event({ t: 'auto', p, c });
    s.timeouts = (s.timeouts || 0) + 1;
    if (s.timeouts >= 3 && !s.bot && this.prompt === null && !this.locked) this.prompt = p;
    this.doPlay(p, c.id, 'auto');
  }

  doPlay(p, id, how) {
    const g = this.game;
    if (!g || this.phase !== 'play' || p < 0) return 'Game nahi chal raha';
    const err = g.play(p, id);
    if (err) return err;
    if (how === 'human') this.seats[p].timeouts = 0;
    this.lastActive = Date.now();
    this.flush();
    this.schedule();
    return null;
  }

  flush() { for (const e of this.game.events.splice(0)) this.event(e); }

  endGame() {
    const T = this.table, r = this.game.result();
    let kotTo = null;
    if (r.a === 4) kotTo = 1; else if (r.b === 4) kotTo = 0;
    T.dehle[0] += r.a; T.dehle[1] += r.b; T.played++;
    T.history.push({ a: r.a, b: r.b, kotTo });
    let over;
    if (this.match) {
      const M = T.match;
      if (r.a === 4) { M.pts[0] += 6; M.kots[1]++; } else if (r.b === 4) { M.pts[1] += 6; M.kots[0]++; } else { M.pts[0] += r.a; M.pts[1] += r.b; }
      M.haath[0] += r.haath[0]; M.haath[1] += r.haath[1];
      over = T.played >= M.games;
      if (over) {
        if (M.pts[0] !== M.pts[1]) M.winner = M.pts[0] > M.pts[1] ? 0 : 1;
        else if (this.match.knockout) {
          if (M.haath[0] !== M.haath[1]) { M.winner = M.haath[0] > M.haath[1] ? 0 : 1; M.note = 'Points barabar, zyada haath wali team Win'; }
          else { M.games++; over = false; M.note = 'Points aur haath barabar, ek aur game'; }
        }
      }
    } else {
      if (kotTo !== null) {
        const K = T.kot;
        if (K.holder === null || K.holder === kotTo) { K.holder = kotTo; K.n++; }
        else { K.n--; if (!K.n) K.holder = null; }
      }
      over = this.settings.lengthType === 'games' ? T.played >= this.settings.games : Date.now() - T.start >= this.settings.minutes * 60_000;
    }
    this.result = { ...r, kotTo, over };
    this.phase = over ? 'final' : 'result';
    this.ready.clear();
    this.recordStats(r, kotTo, over);
    clearTimeout(this.timers.next);
    if (!over) this.timers.next = setTimeout(() => { if (this.phase === 'result') this.newGame(); }, NEXT_GAME_MS);
    this.broadcast();
    if (this.hooks.onUpdate) this.hooks.onUpdate(this);
    if (over && this.hooks.onEnd) this.hooks.onEnd(this);
    if (over && this.match) this.checkEmpty();
  }

  recordStats(r, kotTo, over) {
    const humans = this.seats.map((s, i) => s && !s.bot ? { pid: s.pid, i } : null).filter(Boolean);
    const rows = humans.map(({ pid, i }) => {
      const t = team(i), row = { pid, games: 1, dehle: t === 0 ? r.a : r.b, friends: humans.filter(h => h.pid !== pid).map(h => h.pid) };
      if (kotTo !== null) { if (kotTo === t) row.kot_taken = 1; else row.kot_given = 1; }
      if (over && !this.match) {
        row.tables_p = 1;
        const K = this.table.kot;
        if (K.holder !== null && K.holder !== t) row.tables_w = 1;
      }
      return row;
    });
    db.bumpStats(rows);
  }

  markReady(pid) {
    const i = this.seatOf(pid);
    if (i < 0 || this.phase !== 'result') return;
    this.ready.add(i);
    const waiting = this.seats.some((s, k) => s && !s.bot && s.connected && !this.ready.has(k));
    if (!waiting) { clearTimeout(this.timers.next); this.newGame(); } else this.broadcast();
  }

  // ---------- messages ----------
  listeners() {
    return [...this.seats.filter(s => s && !s.bot && s.ws), ...this.watchers.values()].filter(s => s.ws && s.ws.readyState === 1);
  }

  event(e) {
    const msg = JSON.stringify({ t: 'event', e });
    for (const s of this.listeners()) s.ws.send(msg);
  }

  social(fromPid, msg) {
    const p = this.seatOf(fromPid);
    if (p < 0) return;
    if (msg.t === 'react' && Number.isInteger(msg.to) && msg.to >= 0 && msg.to < 4 && typeof msg.emoji === 'string' && msg.emoji.length <= 8)
      this.event({ t: 'react', p, to: msg.to, emoji: msg.emoji });
    if (msg.t === 'say' && Number.isInteger(msg.line) && msg.line >= 0 && msg.line < 20)
      this.event({ t: 'say', p, line: msg.line });
  }

  sendAvatars() {
    const imgs = this.seats.map(s => (s && typeof s.icon === 'string' && s.icon.startsWith('img:')) ? s.icon : null);
    const msg = JSON.stringify({ t: 'avatars', imgs });
    for (const s of this.listeners()) s.ws.send(msg);
  }

  view(i) {
    const g = this.game, now = Date.now();
    return {
      t: 'state', code: this.code, me: i, host: this.seatOf(this.hostPid), phase: this.phase, voice: Room.voiceReady && this.settings.voice,
      watchers: [...this.watchers.values()].map(w => w.name),
      match: this.match && { tourCode: this.match.tourCode, stage: this.match.stage, round: this.match.round, readyLeft: this.phase === 'ready' ? Math.max(0, this.readyDeadline - now) : 0 },
      settings: this.settings, teamNames: this.teamNames,
      seats: this.seats.map(s => s && { name: s.name, icon: (s.icon || '').startsWith('img:') ? 'img' : s.icon, bot: !!s.bot, connected: !!s.connected }),
      table: this.table && { kot: this.table.kot, dehle: this.table.dehle, played: this.table.played, elapsed: now - this.table.start, dealer: this.table.dealer, history: this.table.history, match: this.table.match || null },
      game: g && this.phase === 'play' ? {
        hand: i >= 0 ? g.hands[i] : [], counts: g.hands.map(h => h.length), trick: g.trick, pileN: g.pile.length,
        trump: g.trump, trumpSetter: g.trumpSetter, streak: g.streak, tens: g.tens, turn: g.turn,
        resolving: g.resolving, winIdx: g.resolving ? g.winningIdx() : -1,
        timeLeft: this.deadline ? Math.max(0, this.deadline - now) : 0, trickNo: g.trickNo,
      } : null,
      result: this.result, ready: [...this.ready],
      prompt: this.seatOf(this.hostPid) === i ? this.prompt : null,
    };
  }

  broadcast() {
    for (let i = 0; i < 4; i++) {
      const s = this.seats[i];
      if (s && !s.bot && s.ws && s.ws.readyState === 1) s.ws.send(JSON.stringify(this.view(i)));
    }
    if (this.watchers.size) {
      const msg = JSON.stringify(this.view(-1));
      for (const w of this.watchers.values()) if (w.ws && w.ws.readyState === 1) w.ws.send(msg);
    }
    db.saveSnapshot('table', this.code, () => this.toJSON());
  }

  // ---------- saving and restoring ----------
  toJSON() {
    const g = this.game;
    return {
      code: this.code, hostPid: this.hostPid, teamNames: this.teamNames, settings: this.settings, phase: this.phase,
      seats: this.seats.map(s => s && { pid: s.pid || null, name: s.name, icon: s.icon && s.icon.length > 60_000 ? '🙂' : s.icon, bot: !!s.bot, forPid: s.forPid || null, timeouts: s.timeouts || 0 }),
      table: this.table, result: this.result, match: this.match, readyDeadline: this.readyDeadline || 0,
      game: g ? { dealer: g.dealer, deck: g.deck, hands: g.hands, trick: g.trick, pile: g.pile, trump: g.trump, trumpSetter: g.trumpSetter, trumpJust: g.trumpJust,
        streak: g.streak, tens: g.tens, tricks: g.tricks, trickNo: g.trickNo, resolving: g.resolving, over: g.over, turn: g.turn } : null,
    };
  }

  static fromJSON(d, onEmpty) {
    const r = new Room(d.code, onEmpty);
    Object.assign(r, { hostPid: d.hostPid, teamNames: d.teamNames, settings: d.settings, phase: d.phase, table: d.table, result: d.result, match: d.match, readyDeadline: d.readyDeadline });
    r.seats = d.seats.map(s => s && (s.bot ? { bot: true, name: s.name, icon: s.icon, forPid: s.forPid, connected: true }
      : { pid: s.pid, name: s.name, icon: s.icon, ws: null, connected: false, bot: false, timeouts: s.timeouts || 0 }));
    if (d.game) r.game = Object.assign(Object.create(Game.prototype), d.game, { events: [] });
    if (r.phase === 'lobby' && !r.humans().length) return null;
    return r;
  }

  // Restart timers after a restore (once hooks are attached).
  resume() {
    if (this.phase === 'play') this.schedule();
    else if (this.phase === 'result') this.timers.next = setTimeout(() => { if (this.phase === 'result') this.newGame(); }, NEXT_GAME_MS);
    else if (this.phase === 'ready') this.armReady();
    this.checkEmpty();
  }
}

Room.voiceReady = false;
module.exports = { Room, TURN_MS };
