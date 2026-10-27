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

const upsertPlayer = (pid, name, icon) => call('players?on_conflict=pid', {
  method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify({ pid, name, icon: icon && icon.length > 60_000 ? null : icon, updated_at: new Date().toISOString() }),
});

const bumpStats = rows => rows.length ? call('rpc/bump_stats', { method: 'POST', body: JSON.stringify({ rows }) }) : null;

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
const allPlayers = async () => (await call(`players?select=${COLS}&order=tw.desc,finals.desc,kot_given.desc,kot_taken.asc&limit=2000`)) || [];
const getPlayer = async pid => ((await call(`players?pid=eq.${encodeURIComponent(pid)}&select=${COLS}`)) || [])[0] || null;

module.exports = { enabled, upsertPlayer, bumpStats, saveSnapshot, deleteSnapshot, loadSnapshots, insertTournament, insertClaim, claimsFor, allPlayers, getPlayer };
