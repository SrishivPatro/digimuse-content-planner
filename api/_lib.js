import crypto from 'node:crypto';

const RURL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const RTOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const COLS = ['brands', 'team', 'plans', 'posts', 'reports'];
export const PREFIX = 'dcp:';

function need(){
  if (!RURL || !RTOKEN) throw new Error('Database not connected. In Vercel, open Storage, add Upstash Redis and connect it to this project, then redeploy.');
}

export async function redis(cmd){
  need();
  const r = await fetch(RURL, { method: 'POST', headers: { Authorization: `Bearer ${RTOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || `Database error ${r.status}`);
  return j.result;
}

export async function pipeline(cmds){
  need();
  const r = await fetch(RURL.replace(/\/$/, '') + '/pipeline', { method: 'POST', headers: { Authorization: `Bearer ${RTOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds) });
  const j = await r.json();
  if (!r.ok || !Array.isArray(j)) throw new Error(j.error || `Database error ${r.status}`);
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

export const tokenFor = pw => crypto.createHash('sha256').update('digimuse-content-planner:' + pw).digest('hex');

// ---------- auth: personal logins (dcp:users) with signed session cookies ----------
export const USERS = PREFIX + 'users';
export const normU = u => String(u || '').trim().toLowerCase();
const SECRET = () => process.env.SESSION_SECRET || crypto.createHash('sha256').update('dcp-session:' + (process.env.TEAM_PASSWORD || '') + ':' + (RTOKEN || '')).digest('hex');
export const ownerVer = () => crypto.createHash('sha256').update('owner:' + (process.env.TEAM_PASSWORD || '')).digest('hex').slice(0, 12);
export const OWNER = { username: 'owner', name: 'Owner', role: 'admin', owner: true, teamId: '' };

export function hashPw(pw){
  const salt = crypto.randomBytes(16).toString('hex');
  return `s1:${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
export function checkPw(pw, stored){
  const [v, salt, h] = String(stored || '').split(':');
  if (v !== 's1' || !salt || !h) return false;
  const a = crypto.scryptSync(String(pw), salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export const safeEq = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
export function sessionCookie(username, ver){
  const p = Buffer.from(JSON.stringify({ u: username, v: ver, e: Date.now() + 30 * 864e5 })).toString('base64url');
  const s = crypto.createHmac('sha256', SECRET()).update(p).digest('base64url');
  return `dcs=${p}.${s}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
}
export const clearCookies = ['dcs=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0', 'dcp=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'];
function readSession(req){
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dcs=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)/); if (!m) return null;
  const exp = crypto.createHmac('sha256', SECRET()).update(m[1]).digest('base64url');
  if (!safeEq(m[2], exp)) return null;
  try { const o = JSON.parse(Buffer.from(m[1], 'base64url').toString()); return o.e > Date.now() ? o : null; } catch (e){ return null; }
}
export async function getUser(u){ const raw = await redis(['HGET', USERS, normU(u)]); return raw ? JSON.parse(raw) : null; }
export async function putUser(u){ await redis(['HSET', USERS, normU(u.username), JSON.stringify(u)]); }
export async function userCount(){ return +(await redis(['HLEN', USERS])) || 0; }
export const publicUser = u => ({ username: u.username, name: u.name || u.username, role: u.role || 'member', teamId: u.teamId || '', mustChange: !!u.mustChange, owner: !!u.owner });

// Returns the signed-in user (truthy) or null. Cached on req.
export async function authed(req){
  if (req._user !== undefined) return req._user;
  const pw = process.env.TEAM_PASSWORD;
  let out = null;
  if (!pw) out = { ...OWNER, open: true };
  else {
    const s = readSession(req);
    if (s){
      if (s.u === 'owner') out = s.v === ownerVer() ? { ...OWNER } : null;
      else { try { const u = await getUser(s.u); if (u && !u.disabled && (u.ver || 0) === s.v) out = publicUser(u); } catch (e){} }
    } else {
      // Old shared-password cookie keeps working only until the first personal login is created.
      const m = (req.headers.cookie || '').match(/(?:^|;\s*)dcp=([a-f0-9]{64})/);
      if (m && safeEq(m[1], tokenFor(pw))){ try { if (await userCount() === 0) out = { ...OWNER, legacy: true }; } catch (e){} }
    }
  }
  req._user = out;
  return out;
}

// ---------- AI usage per client (admin-only view) ----------
export const monthKey = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3).toISOString().slice(0, 7);   // IST month
export async function recordUsage(brandId, u, provider){
  if (!u) return;
  const b = String(brandId || 'other').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 60) || 'other';
  const k = PREFIX + 'usage:' + monthKey();
  await pipeline([
    ['HINCRBY', k, b + '|calls', 1], ['HINCRBY', k, b + '|in', Math.round(u.in || 0)], ['HINCRBY', k, b + '|out', Math.round(u.out || 0)],
    ['HINCRBY', k, b + '|search', Math.round(u.search || 0)], ['HSET', k, b + '|model', String(provider || '') + ':' + String(u.model || '')]
  ]);
}

// ---------- activity log + post version history ----------
export const HIST_KEYS = ['topic', 'hook', 'caption', 'hashtags', 'onImage', 'slides', 'script', 'design', 'langs', 'shots', 'status'];
export async function logActivity(user, col, id, op, data, before){
  const keys = Object.keys(data || {}).slice(0, 14);
  const entry = { at: Date.now(), by: user?.name || user?.username || 'Someone', un: user?.username || '', col, id, op, keys };
  if (col === 'posts' && before) entry.title = String(before.topic || '').slice(0, 80);
  else if (before && (before.name || before.month)) entry.title = String(before.name || before.month).slice(0, 80);
  else if (data && (data.name || data.topic || data.month)) entry.title = String(data.name || data.topic || data.month).slice(0, 80);
  const cmds = [['LPUSH', PREFIX + 'log', JSON.stringify(entry)], ['LTRIM', PREFIX + 'log', 0, 2999]];
  if (col === 'posts' && before && op !== 'delete'){
    const prev = {}; let changed = false;
    for (const k of HIST_KEYS) if (data && k in data && JSON.stringify(before[k] ?? null) !== JSON.stringify(data[k] ?? null) && before[k] != null && before[k] !== ''){ prev[k] = before[k]; changed = true; }
    if (changed && !('status' in prev && Object.keys(prev).length === 1)) cmds.push(['LPUSH', PREFIX + 'hist:' + id, JSON.stringify({ at: Date.now(), by: entry.by, prev })], ['LTRIM', PREFIX + 'hist:' + id, 0, 29]);
  }
  await pipeline(cmds);
}

export const deny = res => res.status(401).json({ error: 'Sign in required' });

export function merge(t, s){
  for (const k in s){
    const v = s[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) merge(t[k], v);
    else t[k] = v;
  }
  return t;
}
