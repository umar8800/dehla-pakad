// Save a game half-way, restore it as a fresh object, and play it to the end.
process.env.RESOLVE_MS = '1'; process.env.BOT_MS = '1'; process.env.NEXT_GAME_MS = '5';
const { Room } = require('../server/room');
const fail = m => { console.error('FAIL:', m); process.exit(1); };
const bots = [0, 1, 2, 3].map(i => ({ bot: true, name: 'B' + i, icon: '🤖' }));
const r = new Room('9001', () => {}, { tourCode: 'T1', matchId: 0, stage: 'league', round: 1, games: 3, knockout: false, teamNames: ['A', 'B'], seats: bots });
r.startTable();
setTimeout(() => {
  if (r.phase !== 'play' && r.phase !== 'result') fail('not playing yet: ' + r.phase);
  const snap = JSON.parse(JSON.stringify(r.toJSON()));
  Object.values(r.timers).forEach(t => clearTimeout(t)); r.hooks = {}; r.phase = 'dead';
  const before = snap.table.played, cardsLeft = snap.game ? snap.game.hands.reduce((n, h) => n + h.length, 0) : 0;
  const r2 = Room.fromJSON(snap, () => {});
  let done = false;
  r2.hooks = { onEnd: x => { done = true; } };
  r2.resume();
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (done) {
      clearInterval(iv);
      const M = r2.table.match;
      if (r2.table.played !== 3) fail('restored match did not finish all games');
      if (r2.table.dehle[0] + r2.table.dehle[1] !== 12) fail('dehle wrong after restore');
      console.log('PASS', { savedAfterGames: before, cardsLeftWhenSaved: cardsLeft, final: M.pts, winner: M.winner });
      process.exit(0);
    }
    if (Date.now() - t0 > 20000) fail('restored match stuck in ' + r2.phase);
  }, 20);
}, 150);
