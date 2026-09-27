import { authed, deny, redis, PREFIX } from './_lib.js';

// GET /api/log                 → recent activity (latest 300)
// GET /api/log?doc=posts/<id>  → activity for one record
// GET /api/log?hist=<postId>   → earlier versions of a post (for restore)
export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  if (!(await authed(req))) return deny(res);
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
