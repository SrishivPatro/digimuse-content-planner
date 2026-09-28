import crypto from 'node:crypto';
import { authed, deny, redis, PREFIX, recordUsage } from './_lib.js';

// POST {action:'generate', prompt, aspect:'4:5'|'9:16'|'1:1', n:1-3, refs:[{mime,data}], brandId}
//   → {images:[{mime,data}]}   (not stored; the browser composes text on top, then saves the one it keeps)
// POST {action:'save', data:<base64 jpeg/png>, mime, old:<url to replace>} → {url}
// POST {action:'delete', url}
const GBASE = 'https://generativelanguage.googleapis.com/v1beta';
let picked = '';
const BLOB = process.env.BLOB_READ_WRITE_TOKEN;

async function listImageModel(){
  const r = await fetch(`${GBASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
  const j = await r.json().catch(() => ({}));
  const ok = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, '')).filter(n => /image/.test(n) && /flash/.test(n));
  return ok.sort().reverse()[0] || null;
}
async function genOne(model, prompt, aspect, refs, key = process.env.GEMINI_API_KEY){
  const r = await fetch(`${GBASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(90e3), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [...refs.map(f => ({ inline_data: { mime_type: f.mime, data: f.data } })), { text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } } })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Image model error ${r.status}`), { status: r.status });
  const part = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
  const d = part?.inlineData || part?.inline_data;
  if (!d?.data) throw Object.assign(new Error('The image model returned no image (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'unknown') + '). Try a different brief.'), { status: 502 });
  return { mime: d.mimeType || d.mime_type || 'image/png', data: d.data };
}
let paidDeadUntil = 0;
const nap = ms => new Promise(r => setTimeout(r, ms));
async function generate(prompt, aspect, n, refs){
  const paid = process.env.GEMINI_API_KEY, free = process.env.GEMINI_API_KEY_FREE;
  if (!paid && !free) throw Object.assign(new Error('Add GEMINI_API_KEY in Vercel to generate creatives.'), { status: 500 });
  // Paid key first (images mostly need billing); the free key is tried too in case its project allows images.
  const keys = [...(paid && paidDeadUntil < Date.now() ? [['paid', paid]] : []), ...(free && free !== paid ? [['free', free]] : []), ...(paid && paidDeadUntil >= Date.now() ? [['paid', paid]] : [])];
  let lastErr; const why = [];
  for (const [kind, key] of keys){
    let model = picked || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const out = []; let busyTries = 0;
    for (let i = 0; i < n; i++){
      try { out.push(await genOne(model, prompt + (n > 1 ? `\n(Variation ${i + 1} of ${n}: take a clearly different composition and angle.)` : ''), aspect, refs, key)); picked = model; }
      catch (e){
        const m = String(e.message || '');
        if (!out.length && (e.status === 404 || /not found|no longer|deprecated|not supported/i.test(m))){ const next = await listImageModel(); if (next && next !== model){ model = next; i--; continue; } }
        if (!out.length && (e.status >= 500 || /high demand|overloaded|unavailable|try again/i.test(m) || e.name === 'TimeoutError') && busyTries++ < 2){ await nap(2000 * busyTries); i--; continue; }
        if (out.length) break;
        lastErr = e; why.push(/prepayment|credit|billing/i.test(m) || e.status === 402 ? 'no_credit' : e.status === 429 || /quota|RESOURCE_EXHAUSTED/i.test(m) ? 'limit' : e.status >= 500 || /high demand|overloaded/i.test(m) ? 'busy' : 'other');
        if (kind === 'paid' && why[why.length - 1] === 'no_credit') paidDeadUntil = Date.now() + 10 * 60e3;
        break;
      }
    }
    if (out.length) return out;
  }
  const code = why.includes('busy') ? 'busy' : why.every(w => w === 'no_credit' || w === 'limit') ? 'no_image_credit' : 'upstream_error';
  throw Object.assign(lastErr || new Error('No image came back'), { code, status: code === 'busy' ? 503 : 502,
    message: code === 'no_image_credit' ? 'AI photos need paid Gemini credit, and the balance is ₹0 right now.' : code === 'busy' ? "Google's image model is busy right now. Try again in a minute." : (lastErr?.message || 'No image came back') });
}
async function save(buf, mime){
  const ext = /png/.test(mime) ? 'png' : 'jpg';
  if (BLOB){
    const { put } = await import('@vercel/blob');
    const b = await put(`creatives/${crypto.randomBytes(8).toString('hex')}.${ext}`, buf, { access: 'public', contentType: mime, token: BLOB, addRandomSuffix: true });
    return b.url;
  }
  if (buf.length > 900000) throw Object.assign(new Error('Image too large to store without Vercel Blob. Connect a Blob store in Vercel → Storage.'), { status: 413 });
  const k = crypto.randomBytes(10).toString('hex');
  await redis(['HSET', PREFIX + 'img', k, mime + ';' + buf.toString('base64')]);
  return '/api/image?k=' + k;
}
async function remove(url){
  if (!url) return;
  const m = String(url).match(/[?&]k=([a-f0-9]+)/);
  if (m) return redis(['HDEL', PREFIX + 'img', m[1]]);
  if (BLOB && /blob\.vercel-storage\.com/.test(url)){ try { const { del } = await import('@vercel/blob'); await del(url, { token: BLOB }); } catch (e) {} }
}

// GET ?k=<id> serves a creative stored in Redis; GET ?u=<blob url> proxies a Vercel Blob image (same origin, so canvas can redraw on it)
async function serve(req, res){
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

export default async function handler(req, res){
  if (!(await authed(req))) return deny(res);
  if (req.method === 'GET') return serve(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
  const b = req.body || {};
  try {
    if (b.action === 'generate'){
      const aspect = ['4:5', '9:16', '1:1', '16:9'].includes(b.aspect) ? b.aspect : '4:5';
      const n = Math.max(1, Math.min(3, +b.n || 1));
      const refs = (Array.isArray(b.refs) ? b.refs : []).filter(f => f && /^image\/(png|jpe?g|webp)$/.test(f.mime) && typeof f.data === 'string').slice(0, 2);
      const images = await generate(String(b.prompt || '').slice(0, 6000), aspect, n, refs);
      try { await recordUsage(b.brandId, { img: images.length, model: picked }, 'gemini-image'); } catch (e) {}
      return res.status(200).json({ images, model: picked });
    }
    if (b.action === 'save'){
      const mime = /^image\/(png|jpe?g|webp)$/.test(b.mime) ? b.mime : 'image/jpeg';
      const buf = Buffer.from(String(b.data || ''), 'base64'); if (!buf.length) return res.status(400).json({ error: 'No image' });
      const url = await save(buf, mime);
      if (b.old) { try { await remove(b.old); } catch (e) {} }
      return res.status(200).json({ url });
    }
    if (b.action === 'delete'){ await remove(b.url); return res.status(200).json({ ok: true }); }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e){
    res.status(e.status === 429 ? 429 : e.status || 500).json({ error: e.message, code: e.code || (e.status === 429 ? 'rate_limited' : 'image_error') });
  }
}
