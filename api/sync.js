import { authed, deny, pipeline, redis, COLS, PREFIX } from './_lib.js';

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  if (!authed(req)) return deny(res);
  try {
    const v = String((await redis(['GET', PREFIX + 'ver'])) ?? '0');
    if (req.query.v != null && String(req.query.v) === v) return res.status(200).json({ same: true, v });
    const out = await pipeline(COLS.map(c => ['HGETALL', PREFIX + c]));
    const data = {};
    COLS.forEach((c, i) => {
      const flat = out[i] || [], m = {};
      for (let k = 0; k < flat.length; k += 2){ try { m[flat[k]] = JSON.parse(flat[k + 1]); } catch (e) {} }
      data[c] = m;
    });
    res.status(200).json({ v, data });
  } catch (e){
    res.status(500).json({ error: e.message });
  }
}
