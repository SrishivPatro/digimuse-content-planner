import { authed, deny, redis, pipeline, merge, logActivity, COLS, PREFIX } from './_lib.js';

const ID = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const user = await authed(req);
  if (!user) return deny(res);
  const { op, col, id, data } = req.body || {};
  if (!COLS.includes(col) || !ID.test(id || '')) return res.status(400).json({ error: 'Bad request' });
  const key = PREFIX + col;
  try {
    let before = null;
    if (op === 'set' || op === 'delete'){ const cur0 = await redis(['HGET', key, id]); try { before = cur0 ? JSON.parse(cur0) : null; } catch (e) {} }
    if (op === 'set'){
      await redis(['HSET', key, id, JSON.stringify(data || {})]);
    } else if (op === 'update'){
      const cur = await redis(['HGET', key, id]);
      if (!cur) return res.status(404).json({ error: 'Not found' });
      before = JSON.parse(cur);
      await redis(['HSET', key, id, JSON.stringify(merge(JSON.parse(cur), data || {}))]);
    } else if (op === 'delete'){
      await redis(['HDEL', key, id]);
    } else {
      return res.status(400).json({ error: 'Unknown operation' });
    }
    const [v] = await pipeline([['INCR', PREFIX + 'ver']]);
    try { await logActivity(user, col, id, op, op === 'delete' ? {} : data, before); } catch (e) {}
    res.status(200).json({ ok: true, v: String(v) });
  } catch (e){
    res.status(500).json({ error: e.message });
  }
}
