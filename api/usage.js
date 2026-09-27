import { authed, deny, redis, PREFIX, monthKey } from './_lib.js';

// Admin only: AI calls and tokens per client for the last 6 months.
export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const me = await authed(req);
  if (!me) return deny(res);
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
