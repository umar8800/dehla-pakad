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
    const res = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers), signal: AbortSignal.timeout(8000) });
    if (!res.ok) { console.error('db', path.split('?')[0], res.status, (await res.text()).slice(0, 200)); return null; }
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch (e) { console.error('db', path.split('?')[0], e.message); return null; }
}

// Without a database (local testing) players and friends live in memory.
const mem = { players: new Map(), links: new Set(), played: new Map(), sessions: [], games: [] };

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
const ACOLS = 'pid,name,icon,username,pin_hash,failed_pins,pin_locked_until';
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

// ---------- activity tracking (admin only) ----------
async function sessionStart(pid, device) {
  if (!enabled) { const now = new Date().toISOString(); mem.sessions.unshift({ id: mem.sessions.length + 1, pid, device, started_at: now, last_at: now }); return mem.sessions.length; }
  const r = await call('sessions?select=id', { method: 'POST', headers: { prefer: 'return=representation' }, body: JSON.stringify({ pid, device }) });
  return r && r[0] ? r[0].id : null;
}
const sessionsTouch = ids => !enabled ? mem.sessions.forEach(x => { if (ids.includes(x.id)) x.last_at = new Date().toISOString(); }) : ids.length ? call(`sessions?id=in.(${ids.map(Number).join(',')})`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ last_at: new Date().toISOString() }) }) : null;
const logGame = rec => enabled ? call('games', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(rec) }) : mem.games.unshift({ ...rec, ended_at: new Date().toISOString() });
// PIN lockout lives in the database so a server restart doesn't reset it.
const setPinFails = (pid, n, until) => {
  if (!enabled) { const p = mem.players.get(pid); if (p) { p.failed_pins = n; p.pin_locked_until = until; } return Promise.resolve(true); }
  return call(`players?pid=eq.${encodeURIComponent(pid)}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ failed_pins: n, pin_locked_until: until }) });
};
// Admin: email on file + trusted devices (token hashes, 30 days).
async function adminInfo(pid) {
  if (!enabled) { const p = mem.players.get(pid); return p && process.env.TEST_ADMIN && p.username === process.env.TEST_ADMIN ? { is_admin: true, admin_email: process.env.TEST_ADMIN_EMAIL || null } : null; }
  const r = await call(`players?pid=eq.${encodeURIComponent(pid)}&select=is_admin,admin_email`);
  return r && r[0] && r[0].is_admin ? r[0] : null;
}
async function adminDeviceAdd(hash, pid, device) {
  const rec = { token_hash: hash, pid, device, expires_at: new Date(Date.now() + 30 * 86400_000).toISOString() };
  if (!enabled) { (mem.adminDevices ||= new Map()).set(hash, rec); return true; }
  return call('admin_devices', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify(rec) });
}
async function adminDeviceCheck(hash, pid) {
  if (!enabled) { const r = (mem.adminDevices || new Map()).get(hash); return !!(r && r.pid === pid && new Date(r.expires_at) > new Date()); }
  const r = await call(`admin_devices?token_hash=eq.${hash}&pid=eq.${encodeURIComponent(pid)}&expires_at=gt.${new Date().toISOString()}&select=token_hash`);
  if (r && r[0]) { call(`admin_devices?token_hash=eq.${hash}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ last_used: new Date().toISOString() }) }); return true; }
  return false;
}
async function adminDevicesRevoke(pid) {
  if (!enabled) { for (const [k, r] of mem.adminDevices || []) if (r.pid === pid) mem.adminDevices.delete(k); return true; }
  return call(`admin_devices?pid=eq.${encodeURIComponent(pid)}`, { method: 'DELETE' });
}
async function isAdmin(pid) {
  if (!enabled) { const p = mem.players.get(pid); return !!(p && process.env.TEST_ADMIN && p.username === process.env.TEST_ADMIN); }   // local tests only
  const r = await call(`players?pid=eq.${encodeURIComponent(pid)}&select=is_admin`);
  return !!(r && r[0] && r[0].is_admin);
}
async function adminData(days) {
  if (!enabled) return {
    players: [...mem.players.values()].filter(p => p.username).map(p => ({ games: 0, tables_p: 0, tables_w: 0, tours: 0, tw: 0, finals: 0, kot_given: 0, kot_taken: 0, dehle: 0, friends: [...(mem.played.get(p.pid) || [])], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...p })),
    sessions: mem.sessions.map(({ id, ...x }) => x), games: mem.games };
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const [players, sessions, games] = await Promise.all([
    call('players?username=not.is.null&select=pid,username,name,icon,created_at,updated_at,games,tables_p,tables_w,tours,tw,finals,kot_given,kot_taken,dehle,friends&order=created_at.asc&limit=5000'),
    call(`sessions?started_at=gte.${since}&select=pid,started_at,last_at,device&order=started_at.desc&limit=20000`),
    call(`games?ended_at=gte.${since}&select=code,kind,started_at,ended_at,players,result&order=ended_at.desc&limit=20000`),
  ]);
  return { players: players || [], sessions: sessions || [], games: games || [] };
}

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

module.exports = { enabled, setPinFails, adminInfo, adminDeviceAdd, adminDeviceCheck, adminDevicesRevoke, sessionStart, sessionsTouch, logGame, isAdmin, adminData, findByUsername, accountOf, createAccount, setIcon, findByFcode, addFriend, removeFriend, friendsOf, playedWith, upsertPlayer, bumpStats, saveSnapshot, deleteSnapshot, loadSnapshots, insertTournament, insertClaim, claimsFor, allPlayers, getPlayer };
