// Tiny Supabase (PostgREST) client. Everything here is optional: without the
// two environment variables the game still runs, it just doesn't save anything.
const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
const enabled = !!(URL_ && KEY);

function headers(extra = {}) {
  const h = { apikey: KEY, 'content-type': 'application/json', ...extra };
  if (KEY && KEY.startsWith('eyJ')) h.authorization = `Bearer ${KEY}`; // legacy service_role JWT
  return h;
}

async function call(path, opts = {}) {
  if (!enabled) return null;
  try {
    const res = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers) });
    if (!res.ok) { console.error('db', path.split('?')[0], res.status, (await res.text()).slice(0, 200)); return null; }
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch (e) { console.error('db', path.split('?')[0], e.message); return null; }
}

// Without a database (local testing) players and friends live in memory.
const mem = { players: new Map(), links: new Set(), played: new Map() };

const upsertPlayer = (pid, name, icon, fcode) => {
  const ic = icon && icon.length > 60_000 ? null : icon;
  if (!enabled) { mem.players.set(pid, { pid, name, icon: ic, fcode }); return Promise.resolve(true); }
  return call('players?on_conflict=pid', {
    method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ pid, name, icon: ic, fcode, updated_at: new Date().toISOString() }),
  });
};

const bumpStats = rows => {
  if (!enabled) { for (const r of rows) { const set = mem.played.get(r.pid) || new Set(); (r.friends || []).forEach(f => set.add(f)); mem.played.set(r.pid, set); } return null; }
  return rows.length ? call('rpc/bump_stats', { method: 'POST', body: JSON.stringify({ rows }) }) : null;
};

// ---------- accounts (username + PIN) ----------
const ACOLS = 'pid,name,icon,username,pin_hash';
async function findByUsername(u) {
  if (!enabled) return [...mem.players.values()].find(p => p.username === u) || null;
  return ((await call(`players?username=eq.${encodeURIComponent(u)}&select=${ACOLS}`)) || [])[0] || null;
}
async function accountOf(pid) {
  if (!enabled) return mem.players.get(pid) || null;
  return ((await call(`players?pid=eq.${encodeURIComponent(pid)}&select=${ACOLS}`)) || [])[0] || null;
}
// Returns false when the username is already taken.
async function createAccount(rec) {
  if (!enabled) {
    if ([...mem.players.values()].some(p => p.username === rec.username)) return false;
    mem.players.set(rec.pid, { ...rec }); return true;
  }
  const r = await call('players', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ ...rec, updated_at: new Date().toISOString() }) });
  return !!r;
}
const setIcon = (pid, icon) => {
  const ic = icon && icon.length > 60_000 ? null : icon;
  if (!enabled) { const p = mem.players.get(pid); if (p) p.icon = ic; return Promise.resolve(true); }
  return call(`players?pid=eq.${encodeURIComponent(pid)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ icon: ic, updated_at: new Date().toISOString() }) });
};

// ---------- friends ----------
const PCOLS = 'pid,name,icon,fcode';
async function findByFcode(fc) {
  if (!enabled) return [...mem.players.values()].find(p => p.fcode === fc) || null;
  return ((await call(`players?fcode=eq.${encodeURIComponent(fc)}&select=${PCOLS}`)) || [])[0] || null;
}
async function addFriend(a, b) {
  if (!enabled) { mem.links.add(a + '|' + b); mem.links.add(b + '|' + a); return true; }
  return call('friend_links?on_conflict=a,b', { method: 'POST', headers: { prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify([{ a, b }, { a: b, b: a }]) });
}
async function removeFriend(a, b) {
  if (!enabled) { mem.links.delete(a + '|' + b); mem.links.delete(b + '|' + a); return true; }
  await call(`friend_links?a=eq.${encodeURIComponent(a)}&b=eq.${encodeURIComponent(b)}`, { method: 'DELETE' });
  return call(`friend_links?a=eq.${encodeURIComponent(b)}&b=eq.${encodeURIComponent(a)}`, { method: 'DELETE' });
}
async function playersByPid(pids) {
  if (!pids.length) return [];
  if (!enabled) return pids.map(p => mem.players.get(p)).filter(Boolean);
  return (await call(`players?username=not.is.null&pid=in.(${pids.map(p => '"' + p.replace(/"/g, '') + '"').join(',')})&select=${PCOLS}`)) || [];
}
async function friendsOf(pid) {
  let ids;
  if (!enabled) ids = [...mem.links].filter(k => k.startsWith(pid + '|')).map(k => k.slice(pid.length + 1));
  else ids = ((await call(`friend_links?a=eq.${encodeURIComponent(pid)}&select=b&order=created_at.desc`)) || []).map(r => r.b);
  return playersByPid(ids);
}
async function playedWith(pid) {
  if (!enabled) return playersByPid([...(mem.played.get(pid) || [])]);
  const me = ((await call(`players?pid=eq.${encodeURIComponent(pid)}&select=friends`)) || [])[0];
  return playersByPid((me && me.friends || []).slice(-40));
}

// Snapshots are written at most every 2 seconds per table/tournament.
const pending = new Map();
function saveSnapshot(kind, code, getState) {
  const key = kind + ':' + code;
  if (!enabled || pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    let state;
    try { state = getState(); } catch (e) { return console.error('snapshot', e.message); }
    if (!state) return;
    call('snapshots?on_conflict=kind,code', {
      method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ kind, code, state, updated_at: new Date().toISOString() }),
    });
  }, 2000));
}
const deleteSnapshot = (kind, code) => call(`snapshots?kind=eq.${kind}&code=eq.${encodeURIComponent(code)}`, { method: 'DELETE' });
const loadSnapshots = async kind => (await call(`snapshots?kind=eq.${kind}&select=code,state,updated_at`)) || [];

const insertTournament = rec => call('tournaments', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(rec) });
const insertClaim = rec => call('prize_claims', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(rec) });
const claimsFor = async code => (await call(`prize_claims?tour_code=eq.${encodeURIComponent(code)}&select=name,email,created_at&order=created_at`)) || [];

const COLS = 'pid,name,icon,tw,finals,tours,tables_w,tables_p,games,kot_given,kot_taken,dehle,friends';
const allPlayers = async () => (await call(`players?select=${COLS}&username=not.is.null&order=tw.desc,finals.desc,kot_given.desc,kot_taken.asc&limit=2000`)) || [];
const getPlayer = async pid => ((await call(`players?pid=eq.${encodeURIComponent(pid)}&select=${COLS}`)) || [])[0] || null;

module.exports = { enabled, findByUsername, accountOf, createAccount, setIcon, findByFcode, addFriend, removeFriend, friendsOf, playedWith, upsertPlayer, bumpStats, saveSnapshot, deleteSnapshot, loadSnapshots, insertTournament, insertClaim, claimsFor, allPlayers, getPlayer };
