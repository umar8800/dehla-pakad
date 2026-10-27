// A friends table: 4 seats, a code, house settings and the running Kot score.
const { Game, team } = require('./engine');

const TURN_MS = +process.env.TURN_MS || 60_000;          // each human turn
const RESOLVE_MS = +process.env.RESOLVE_MS || 1_500;    // pause to show a finished trick
const NEXT_GAME_MS = 25_000;     // auto-start the next game if not everyone taps
const BOT_NAMES = ['Zara', 'Imran', 'Bilal', 'Ayesha', 'Hamza', 'Sana', 'Faisal', 'Noor', 'Danish', 'Hira', 'Kabir', 'Mehak'];
const BOT_ICONS = ['🐯', '🦁', '🐼', '🦊', '🐵', '🦉', '🐸', '🐨', '🐺', '🐻'];
const pick = a => a[Math.floor(Math.random() * a.length)];

class Room {
  constructor(code, onEmpty) {
    this.code = code;
    this.onEmpty = onEmpty;
    this.seats = [null, null, null, null];
    this.hostPid = null;
    this.teamNames = ['', ''];
    this.settings = { lengthType: 'games', games: 7, minutes: 30, showDehle: false };
    this.phase = 'lobby';
    this.table = null;
    this.game = null;
    this.result = null;
    this.ready = new Set();
    this.timers = {};
    this.deadline = 0;
    this.prompt = null;          // seat the host is asked to hand to a bot
    this.lastActive = Date.now();
  }

  // ---------- people ----------
  humans() { return this.seats.filter(s => s && !s.bot); }
  seatOf(pid) { return this.seats.findIndex(s => s && !s.bot && s.pid === pid); }
  isHost(pid) { return pid === this.hostPid; }

  join(client) {
    this.lastActive = Date.now();
    let i = this.seatOf(client.pid);
    if (i >= 0) {                                    // coming back
      Object.assign(this.seats[i], { ws: client.ws, connected: true, name: client.name, icon: client.icon });
      this.event({ t: 'back', p: i });
      this.sendAvatars();
      this.broadcast();
      return null;
    }
    i = this.seats.findIndex(s => !s);
    if (i < 0 && this.phase !== 'lobby') {
      // A bot keeping a seat warm: the original player gets it back first, anyone else otherwise.
      i = this.seats.findIndex(s => s && s.bot && s.forPid === client.pid);
      if (i < 0) i = this.seats.findIndex(s => s && s.bot);
    }
    if (i < 0) return 'Table bhar gayi hai';
    this.seats[i] = { pid: client.pid, name: client.name, icon: client.icon, ws: client.ws, connected: true, bot: false, timeouts: 0 };
    if (!this.hostPid) this.hostPid = client.pid;
    this.event({ t: 'joined', p: i });
    this.sendAvatars();
    this.broadcast();
    return null;
  }

  disconnect(pid) {
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
    const i = this.seatOf(pid);
    if (i < 0) return;
    if (this.phase === 'lobby') this.seats[i] = null;
    else this.seats[i] = this.makeBot(pid);         // a bot finishes their games
    this.event({ t: 'left', p: i });
    if (this.hostPid === pid) {
      const h = this.humans().find(s => s.connected) || this.humans()[0];
      this.hostPid = h ? h.pid : null;
    }
    if (this.phase !== 'lobby') this.schedule(); else this.broadcast();
    this.checkEmpty();
  }

  checkEmpty() {
    if (!this.humans().some(s => s.connected)) {
      clearTimeout(this.timers.empty);
      this.timers.empty = setTimeout(() => { if (!this.humans().some(s => s.connected)) this.close(); }, 30 * 60_000);
    }
  }

  close() { Object.values(this.timers).forEach(t => clearTimeout(t)); this.onEmpty(this.code); }

  makeBot(forPid) {
    const used = this.seats.filter(Boolean).map(s => s.name);
    return { bot: true, forPid: forPid || null, name: pick(BOT_NAMES.filter(n => !used.includes(n))) || 'Bot', icon: pick(BOT_ICONS), connected: true };
  }

  // ---------- lobby actions (host) ----------
  hostAction(pid, msg) {
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
    } else if (msg.a === 'start') {
      if (this.seats.some(s => !s)) return 'Pehle chaaron seats bharo';
      return this.startTable();
    }
    this.broadcast();
  }

  // ---------- table flow ----------
  startTable() {
    this.table = { kot: { holder: null, n: 0 }, dehle: [0, 0], played: 0, start: Date.now(), dealer: 3, history: [] };
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
      this.timers.bot = setTimeout(() => this.doPlay(p, g.botCard(p).id, 'bot'), 700 + Math.random() * 1100);
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
    if (s.timeouts >= 3 && !s.bot && this.prompt === null) this.prompt = p;
    this.doPlay(p, c.id, 'auto');
  }

  doPlay(p, id, how) {
    const g = this.game;
    if (!g || this.phase !== 'play') return 'Game nahi chal raha';
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
    if (kotTo !== null) {
      const K = T.kot;
      if (K.holder === null || K.holder === kotTo) { K.holder = kotTo; K.n++; }
      else { K.n--; if (!K.n) K.holder = null; }
    }
    T.dehle[0] += r.a; T.dehle[1] += r.b; T.played++;
    T.history.push({ a: r.a, b: r.b, kotTo });
    const over = this.settings.lengthType === 'games' ? T.played >= this.settings.games : Date.now() - T.start >= this.settings.minutes * 60_000;
    this.result = { ...r, kotTo, over };
    this.phase = over ? 'final' : 'result';
    this.ready.clear();
    clearTimeout(this.timers.next);
    if (!over) this.timers.next = setTimeout(() => { if (this.phase === 'result') this.newGame(); }, NEXT_GAME_MS);
    this.broadcast();
  }

  markReady(pid) {
    const i = this.seatOf(pid);
    if (i < 0 || this.phase !== 'result') return;
    this.ready.add(i);
    const waiting = this.seats.some((s, k) => s && !s.bot && s.connected && !this.ready.has(k));
    if (!waiting) { clearTimeout(this.timers.next); this.newGame(); } else this.broadcast();
  }

  // ---------- messages ----------
  event(e) {
    const msg = JSON.stringify({ t: 'event', e });
    for (const s of this.seats) if (s && !s.bot && s.ws && s.ws.readyState === 1) s.ws.send(msg);
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
    for (const s of this.seats) if (s && !s.bot && s.ws && s.ws.readyState === 1) s.ws.send(msg);
  }

  view(i) {
    const g = this.game, now = Date.now();
    return {
      t: 'state', code: this.code, me: i, host: this.seatOf(this.hostPid), phase: this.phase,
      settings: this.settings, teamNames: this.teamNames,
      seats: this.seats.map(s => s && { name: s.name, icon: (s.icon || '').startsWith('img:') ? 'img' : s.icon, bot: !!s.bot, connected: !!s.connected }),
      table: this.table && { kot: this.table.kot, dehle: this.table.dehle, played: this.table.played, elapsed: now - this.table.start, dealer: this.table.dealer, history: this.table.history },
      game: g && this.phase === 'play' ? {
        hand: g.hands[i], counts: g.hands.map(h => h.length), trick: g.trick, pileN: g.pile.length,
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
  }
}

module.exports = { Room, TURN_MS };
