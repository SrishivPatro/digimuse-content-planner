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

export function authed(req){
  const pw = process.env.TEAM_PASSWORD;
  if (!pw) return true;
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)dcp=([a-f0-9]{64})/);
  if (!m) return false;
  const a = Buffer.from(m[1]), b = Buffer.from(tokenFor(pw));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
