import { authed, deny, redis, PREFIX, monthKey } from './_lib.js';

// GET /api/log                 → recent activity (latest 300)
// GET /api/log?doc=posts/<id>  → activity for one record
// GET /api/log?hist=<postId>   → earlier versions of a post (for restore)
// GET /api/log?usage=1         → admins only: AI calls, tokens and images per client, last 6 months
export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const me = await authed(req);
  if (!me) return deny(res);
  if (req.query?.usage) return usage(me, res);
  try {
    const q = req.query || {};
    if (q.hist){
      const id = String(q.hist).replace(/[^A-Za-z0-9_\-.~:@+]/g, '').slice(0, 200);
      const raw = await redis(['LRANGE', PREFIX + 'hist:' + id, 0, 29]) || [];
      return res.status(200).json({ versions: raw.map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
    }
    const raw = await redis(['LRANGE', PREFIX + 'log', 0, 2999]) || [];
    let items = raw.map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
    if (q.doc){ const [col, id] = String(q.doc).split('/'); items = items.filter(e => e.col === col && e.id === id); }
    if (q.brand){ const b = String(q.brand); items = items.filter(e => (e.col === 'brands' && e.id === b) || e.brandId === b); }
    res.status(200).json({ items: items.slice(0, +q.limit || 300) });
  } catch (e){ res.status(500).json({ error: e.message }); }
}

async function usage(me, res){
  if (me.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
  try {
    const months = []; const d = new Date();
    for (let i = 0; i < 6; i++){ months.push(monthKey(new Date(d.getFullYear(), d.getMonth() - i, 15))); }
    const out = {};
    for (const m of [...new Set(months)]){
      const flat = await redis(['HGETALL', PREFIX + 'usage:' + m]) || []; const rows = {};
      for (let i = 0; i < flat.length; i += 2){ const [b, f] = String(flat[i]).split('|'); (rows[b] = rows[b] || {})[f] = f === 'model' ? flat[i + 1] : +flat[i + 1] || 0; }
      out[m] = rows;
    }
    res.status(200).json({ months: out });
  } catch (e){ res.status(500).json({ error: e.message }); }
}
