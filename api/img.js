import { authed, deny, redis, PREFIX } from './_lib.js';

// Serves creatives stored in Redis (used when no Vercel Blob store is connected).
export default async function handler(req, res){
  if (!(await authed(req))) return deny(res);
  const u = String(req.query?.u || '');
  if (u){   // proxy a Vercel Blob creative so the browser can redraw text on it (same origin, no canvas taint)
    let x; try { x = new URL(u); } catch (e) { return res.status(400).end(); }
    if (x.protocol !== 'https:' || !/\.blob\.vercel-storage\.com$/.test(x.hostname)) return res.status(400).end();
    const r = await fetch(x.href); if (!r.ok) return res.status(404).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg'); res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.end(Buffer.from(await r.arrayBuffer()));
  }
  const k = String(req.query?.k || '').replace(/[^a-f0-9]/g, '');
  if (!k) return res.status(400).end();
  const v = await redis(['HGET', PREFIX + 'img', k]);
  if (!v) return res.status(404).end();
  const i = v.indexOf(';');
  res.setHeader('Content-Type', v.slice(0, i) || 'image/jpeg');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.end(Buffer.from(v.slice(i + 1), 'base64'));
}
