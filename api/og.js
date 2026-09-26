import { authed, deny } from './_lib.js';

// Verifies reference links: the page must open and carry a real preview image.
// With images:true it also returns the image bytes (base64) so decks can embed them.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|metadata\.)/i;
const GENERIC = /facebook_share_image|default_share|pinterest_logo|logo[-_]?(share|og)|\/favicon/i;
const dec = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/gi, '/').trim();

function safe(u){
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !PRIVATE.test(x.hostname) && x.hostname.includes('.') ? x : null; } catch (e) { return null; }
}
function meta(html, key){
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, 'i');
  return dec((html.match(re1) || html.match(re2) || [])[1]);
}

async function check(url, withImage){
  const u = safe(url); if (!u) return { url, ok: false, why: 'bad link' };
  try {
    const r = await fetch(u.href, { headers: { 'User-Agent': UA, Accept: 'text/html,image/*;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(9000) });
    if (!r.ok) return { url, ok: false, why: 'page did not open (' + r.status + ')' };
    const final = r.url || u.href; const ct = r.headers.get('content-type') || '';
    let img = '', title = '';
    if (ct.startsWith('image/')) img = final;
    else {
      const html = (await r.text()).slice(0, 400000);
      img = meta(html, 'og:image') || meta(html, 'twitter:image') || meta(html, 'og:image:url');
      title = meta(html, 'og:title') || dec((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]).slice(0, 140);
      if (/pinterest\./i.test(u.hostname) && /\/pin\//.test(u.pathname) && !/\/pin\//.test(new URL(final).pathname)) return { url, ok: false, why: 'pin no longer exists' };
    }
    if (img && img.startsWith('//')) img = 'https:' + img;
    if (img && !/^https?:/i.test(img)) { try { img = new URL(img, final).href; } catch (e) { img = ''; } }
    if (!img || GENERIC.test(img)) return { url, final, ok: true, title, img: '', why: 'no preview image' };
    const out = { url, final, ok: true, title, img };
    if (withImage){
      const iu = safe(img);
      if (iu){
        try {
          const ir = await fetch(iu.href, { headers: { 'User-Agent': UA, Referer: final }, signal: AbortSignal.timeout(9000) });
          const ict = ir.headers.get('content-type') || '';
          if (ir.ok && /^image\/(png|jpe?g|gif|webp)/i.test(ict)){
            const buf = Buffer.from(await ir.arrayBuffer());
            if (buf.length < 4 * 1024 * 1024) out.data = `data:${ict.split(';')[0]};base64,${buf.toString('base64')}`;
          }
        } catch (e) {}
      }
    }
    return out;
  } catch (e){
    return { url, ok: false, why: 'page did not open' };
  }
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authed(req)) return deny(res);
  const urls = [...new Set((Array.isArray(req.body?.urls) ? req.body.urls : []).map(String))].slice(0, 24);
  const withImage = !!req.body?.images;
  const results = [];
  for (let i = 0; i < urls.length; i += 6) results.push(...await Promise.all(urls.slice(i, i + 6).map(u => check(u, withImage))));
  res.status(200).json({ results });
}
