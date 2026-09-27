import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { redis, pipeline, COLS, PREFIX, USERS } from './_lib.js';

// Encrypted backups of all planner data to the Vercel Blob store (which is public, so every backup is AES-256-GCM encrypted).
// Key: BACKUP_KEY, else SESSION_SECRET, else derived from TEAM_PASSWORD. Changing that secret makes older backups unreadable.
const LIST = PREFIX + 'backups', LAST = PREFIX + 'backups:last', LOCK = PREFIX + 'backups:lock', KEEP = 30;
const secret = () => process.env.BACKUP_KEY || process.env.SESSION_SECRET || ('team:' + (process.env.TEAM_PASSWORD || '') + ':' + (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || ''));
const keyOf = () => crypto.createHash('sha256').update('dcp-backup:' + secret()).digest();
export const keyId = () => crypto.createHash('sha256').update(keyOf()).digest('hex').slice(0, 10);
export const blobReady = () => !!process.env.BLOB_READ_WRITE_TOKEN;

async function hgetall(k){ const flat = await redis(['HGETALL', k]) || []; const m = {}; for (let i = 0; i < flat.length; i += 2) m[flat[i]] = flat[i + 1]; return m; }
async function snapshot(){
  const out = await pipeline([...COLS.map(c => ['HGETALL', PREFIX + c]), ['HGETALL', USERS], ['HGETALL', PREFIX + 'settings']]);
  const toMap = flat => { const m = {}; for (let i = 0; i < (flat || []).length; i += 2) m[flat[i]] = flat[i + 1]; return m; };
  const data = {}; COLS.forEach((c, i) => { data[c] = toMap(out[i]); });
  return { v: 1, at: Date.now(), data, users: toMap(out[COLS.length]), settings: toMap(out[COLS.length + 1]) };
}
function seal(obj){
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', keyOf(), iv);
  const body = Buffer.concat([c.update(zlib.gzipSync(Buffer.from(JSON.stringify(obj)))), c.final()]);
  return Buffer.concat([Buffer.from('DCPB1'), iv, c.getAuthTag(), body]);
}
function open(buf){
  if (buf.subarray(0, 5).toString() !== 'DCPB1') throw new Error('Not a planner backup');
  const iv = buf.subarray(5, 17), tag = buf.subarray(17, 33), d = crypto.createDecipheriv('aes-256-gcm', keyOf(), iv); d.setAuthTag(tag);
  try { return JSON.parse(zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(33)), d.final()])).toString()); }
  catch (e){ throw new Error('This backup was made with a different SESSION_SECRET / BACKUP_KEY and cannot be opened with the current one.'); }
}
export async function listBackups(){ return ((await redis(['LRANGE', LIST, 0, KEEP - 1])) || []).map(x => { try { return JSON.parse(x); } catch (e){ return null; } }).filter(Boolean); }
export async function makeBackup(by = 'auto', note = ''){
  if (!blobReady()) throw Object.assign(new Error('Connect a Vercel Blob store to keep backups in the cloud. You can still download a copy.'), { status: 400 });
  const snap = await snapshot(); const buf = seal(snap);
  const { put, del } = await import('@vercel/blob');
  const stamp = new Date(snap.at + 5.5 * 3600e3).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const b = await put(`backups/planner-${stamp}.dcpb`, buf, { access: 'public', token: process.env.BLOB_READ_WRITE_TOKEN, contentType: 'application/octet-stream', addRandomSuffix: true });
  const counts = Object.fromEntries(COLS.map(c => [c, Object.keys(snap.data[c]).length])); counts.logins = Object.keys(snap.users).length;
  const meta = { url: b.url, at: snap.at, by, note, bytes: buf.length, counts, key: keyId() };
  await redis(['LPUSH', LIST, JSON.stringify(meta)]); await redis(['SET', LAST, String(snap.at)]);
  const old = ((await redis(['LRANGE', LIST, KEEP, -1])) || []).map(x => { try { return JSON.parse(x).url; } catch (e){ return ''; } }).filter(Boolean);
  if (old.length){ try { await del(old, { token: process.env.BLOB_READ_WRITE_TOKEN }); } catch (e) {} await redis(['LTRIM', LIST, 0, KEEP - 1]); }
  return meta;
}
// Runs at most once a day, whoever opens the tool first.
export async function autoBackup(){
  if (!blobReady()) return { skipped: 'no blob' };
  const last = +(await redis(['GET', LAST])) || 0; if (Date.now() - last < 20 * 3600e3) return { skipped: 'recent', last };
  const got = await redis(['SET', LOCK, '1', 'NX', 'EX', 600]); if (!got) return { skipped: 'running' };
  try { return { made: await makeBackup('auto') }; } finally { await redis(['DEL', LOCK]); }
}
export async function restoreBackup(url, by){
  const list = await listBackups(); const meta = list.find(x => x.url === url); if (!meta) throw Object.assign(new Error('Unknown backup'), { status: 404 });
  const r = await fetch(url); if (!r.ok) throw Object.assign(new Error('Could not download that backup from storage'), { status: 502 });
  const snap = open(Buffer.from(await r.arrayBuffer()));
  const safety = await makeBackup(by, 'Safety copy before a restore');
  for (const c of COLS){
    const key = PREFIX + c; const entries = Object.entries(snap.data?.[c] || {});
    await redis(['DEL', key]);
    for (let i = 0; i < entries.length; i += 200){ const cmd = ['HSET', key]; for (const [id, val] of entries.slice(i, i + 200)) cmd.push(id, val); await redis(cmd); }
  }
  // Logins: add back any that are missing; never overwrite a login that exists now (keeps current passwords).
  const now = await hgetall(USERS); for (const [u, val] of Object.entries(snap.users || {})) if (!now[u]) await redis(['HSET', USERS, u, val]);
  for (const [k, val] of Object.entries(snap.settings || {})) await redis(['HSET', PREFIX + 'settings', k, val]);
  await redis(['INCR', PREFIX + 'ver']);
  return { restored: meta.at, safety };
}
