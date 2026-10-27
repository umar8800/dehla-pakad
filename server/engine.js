// Dehla Pakad rules engine. Pure game logic, no networking.
// Seats 0..3 go round the table; partners sit opposite (team = seat % 2).
const crypto = require('crypto');

const SUITS = ['S', 'H', 'C', 'D']; // alternates black / red
const team = p => p % 2;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newDeck() {
  const d = [];
  let id = 0;
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ s, r, id: id++ });
  return shuffle(d);
}

class Game {
  constructor(dealer) {
    this.dealer = dealer;
    this.deck = newDeck();
    this.hands = [[], [], [], []];
    this.trick = [];          // [{p, c}]
    this.pile = [];           // finished tricks waiting in the middle: [{w, plays}]
    this.trump = null;
    this.trumpSetter = null;
    this.trumpJust = false;   // the trick in progress is the one where trump was decided
    this.streak = null;       // seat that needs one more trick in a row
    this.tens = [[], []];     // tens captured per team
    this.tricks = [0, 0];     // tricks won per team
    this.trickNo = 0;
    this.resolving = false;   // 4 cards down, waiting to be swept
    this.over = false;
    this.events = [];         // things to tell players about, drained by the room
    this.deal(5);
    this.turn = (dealer + 1) % 4;
  }

  deal(n) {
    for (let k = 0; k < n; k++) for (let i = 1; i <= 4; i++) {
      const p = (this.dealer + i) % 4;
      if (this.deck.length) this.hands[p].push(this.deck.pop());
    }
    this.sortHands();
  }

  sortHands() {
    const off = this.trump ? SUITS.indexOf(this.trump) : 0;
    const order = s => (SUITS.indexOf(s) - off + 4) % 4;
    for (const h of this.hands) h.sort((a, b) => order(a.s) - order(b.s) || a.r - b.r);
  }

  legal(p) {
    const h = this.hands[p];
    if (!this.trick.length) return h.slice();
    const led = this.trick[0].c.s;
    const f = h.filter(c => c.s === led);
    return f.length ? f : h.slice();
  }

  beats(c, b) {
    if (this.trump && c.s === this.trump && b.s !== this.trump) return true;
    return c.s === b.s && c.r > b.r;
  }

  winningIdx() {
    let best = 0;
    for (let i = 1; i < this.trick.length; i++) if (this.beats(this.trick[i].c, this.trick[best].c)) best = i;
    return best;
  }

  pileCards() { return this.pile.flatMap(t => t.plays.map(x => x.c)); }
  pileTens() { return this.pileCards().filter(c => c.r === 10); }

  // Returns an error string, or null when the card was played.
  play(p, cardId) {
    if (this.over || this.resolving) return 'Abhi chal nahi sakte';
    if (p !== this.turn) return 'Tumhari baari nahi hai';
    const card = this.hands[p].find(c => c.id === cardId);
    if (!card) return 'Ye patta tumhare paas nahi';
    if (!this.legal(p).some(c => c.id === cardId)) return 'follow';
    const led = this.trick.length ? this.trick[0].c.s : null;
    this.hands[p] = this.hands[p].filter(c => c.id !== cardId);
    this.trick.push({ p, c: card });
    this.events.push({ t: 'played', p, c: card });
    if (!this.trump && led && card.s !== led) {
      this.trump = card.s;
      this.trumpSetter = p;
      this.trumpJust = true;
      this.sortHands();
      this.events.push({ t: 'trump', p, s: card.s, led });
    }
    if (this.trick.length === 4) this.resolving = true;
    else this.turn = (p + 1) % 4;
    return null;
  }

  // Sweep the finished trick. Call after a short pause so players can see it.
  resolve() {
    if (!this.resolving) return;
    const w = this.trick[this.winningIdx()].p;
    this.trickNo++;
    this.pile.push({ w, plays: this.trick.slice(), trumpTrick: this.trumpJust });
    this.tricks[team(w)]++;
    this.trick = [];
    this.resolving = false;
    const handsEmpty = this.hands.every(h => !h.length);
    const last = handsEmpty && !this.deck.length;
    this.events.push({ t: 'trick', w, no: this.trickNo });

    if (last) {
      this.capture(w, 'last');
    } else if (!this.trump) {
      if (handsEmpty) { this.deal(1); this.events.push({ t: 'dealOne' }); }
    } else if (this.trumpJust) {
      this.trumpJust = false;
      this.streak = this.pileTens().length ? w : null;
      this.deal(this.deck.length / 4);
      this.events.push({ t: 'dealRest', leader: w });
    } else if (this.pileTens().length) {
      if (this.streak === w) this.capture(w, 'streak');
      else {
        const stopped = this.streak;
        this.streak = w;
        this.events.push({ t: 'streak', p: w, stopped });
      }
    } else {
      this.streak = null;
    }

    if (last) { this.over = true; this.turn = -1; return; }
    this.turn = w;
  }

  capture(w, why) {
    const cards = this.pileCards();
    const tens = cards.filter(c => c.r === 10);
    this.tens[team(w)].push(...tens);
    this.events.push({ t: 'capture', w, why, n: cards.length, tens });
    this.pile = [];
    this.streak = null;
  }

  result() {
    return { a: this.tens[0].length, b: this.tens[1].length, haath: this.tricks.slice() };
  }

  // Unbiased auto-play for a timed-out player: highest card of the led suit,
  // otherwise the highest card in the hand. Ties go Hukum, Lal Paan, Chidi, Eent.
  autoCard(p) {
    const h = this.hands[p];
    const led = this.trick.length ? this.trick[0].c.s : null;
    const pool = led && h.some(c => c.s === led) ? h.filter(c => c.s === led) : h;
    return pool.reduce((a, b) => (b.r > a.r || (b.r === a.r && SUITS.indexOf(b.s) < SUITS.indexOf(a.s))) ? b : a);
  }

  // ---- bot brain (same as the prototype) ----
  botCard(p) {
    const lowest = (cards, avoidTen = true) => {
      const pool = avoidTen && cards.some(c => c.r !== 10) ? cards.filter(c => c.r !== 10) : cards;
      return pool.reduce((a, b) => b.r < a.r ? b : a);
    };
    const highest = cards => cards.reduce((a, b) => b.r > a.r ? b : a);
    const hand = this.hands[p], L = this.legal(p);
    if (!this.trick.length) {
      const nonT = hand.filter(c => c.s !== this.trump);
      if (this.streak !== null) {
        if (this.trump) { const tr = hand.filter(c => c.s === this.trump); if (tr.length) { const h = highest(tr); if (h.r >= 12) return h; } }
        const a = nonT.find(c => c.r === 14); if (a) return a;
        const k = nonT.find(c => c.r === 13); if (k) return k;
      }
      const ace = nonT.find(c => c.r === 14);
      if (ace && Math.random() < 0.7) return ace;
      const pool = nonT.length ? nonT : hand, by = {};
      pool.forEach(c => (by[c.s] = by[c.s] || []).push(c));
      return lowest(Object.values(by).sort((a, b) => b.length - a.length)[0]);
    }
    const led = this.trick[0].c.s, cur = this.trick[this.winningIdx()], partner = (p + 2) % 4;
    const partnerWin = cur.p === partner, lastToPlay = this.trick.length === 3;
    const stakes = this.pileTens().length > 0 || this.trick.some(t => t.c.r === 10) || (this.streak !== null && team(this.streak) !== team(p));
    if (hand.some(c => c.s === led)) {
      if (partnerWin) {
        const safe = lastToPlay || (cur.c.r >= 13 && cur.c.s === led) || (this.trump && cur.c.s === this.trump);
        const ten = L.find(c => c.r === 10);
        if (safe && ten) return ten;
        return lowest(L);
      }
      const beat = L.filter(c => this.beats(c, cur.c));
      if (beat.length) {
        if (lastToPlay) return lowest(beat, false);
        const nonTen = beat.filter(c => c.r !== 10);
        if (nonTen.length) return stakes ? highest(nonTen) : lowest(nonTen);
      }
      return lowest(L);
    }
    if (!this.trump) {
      const count = {};
      hand.forEach(c => count[c.s] = (count[c.s] || 0) + 1);
      const s = Object.keys(count).sort((x, y) => count[y] - count[x])[0];
      return lowest(hand.filter(c => c.s === s));
    }
    const trumps = hand.filter(c => c.s === this.trump);
    if (!partnerWin && trumps.length) {
      const beat = trumps.filter(c => this.beats(c, cur.c));
      if (beat.length && (stakes || lastToPlay || Math.random() < 0.4)) return lowest(beat, !lastToPlay);
    }
    const others = hand.filter(c => c.s !== this.trump);
    if (partnerWin && (lastToPlay || cur.c.s === this.trump)) { const t = others.find(c => c.r === 10); if (t) return t; }
    return others.length ? lowest(others) : lowest(hand);
  }
}

module.exports = { Game, team, SUITS };
