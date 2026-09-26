import { authed, deny } from './_lib.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?|metadata\.)/i;

async function get(url, ms = 12000){
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
  return r;
}
const strip = h => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

async function shopify(origin){
  const out = [];
  for (let page = 1; page <= 4; page++){
    const r = await get(`${origin}/products.json?limit=250&page=${page}`);
    if (!r.ok) break;
    const j = await r.json().catch(() => null);
    if (!j || !Array.isArray(j.products) || !j.products.length) break;
    for (const p of j.products){
      const prices = (p.variants || []).map(v => Number(v.price)).filter(n => isFinite(n) && n > 0);
      const cmp = (p.variants || []).map(v => Number(v.compare_at_price)).filter(n => isFinite(n) && n > 0);
      const min = prices.length ? Math.min(...prices) : null;
      out.push({
        name: p.title,
        what: [p.product_type, (p.tags || []).slice(0, 4).join(', ')].filter(Boolean).join(' · '),
        benefits: strip(p.body_html).slice(0, 240),
        price: min != null ? (prices.length > 1 && Math.max(...prices) !== min ? `from ${min}` : String(min)) : '',
        offer: cmp.length && min != null && Math.max(...cmp) > min ? `was ${Math.max(...cmp)}` : '',
        url: `${origin}/products/${p.handle}`
      });
    }
    if (j.products.length < 250) break;
  }
  return out;
}

async function woo(origin){
  const out = [];
  for (let page = 1; page <= 5; page++){
    const r = await get(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!r.ok) break;
    const j = await r.json().catch(() => null);
    if (!Array.isArray(j) || !j.length) break;
    for (const p of j){
      const pr = p.prices || {}; const unit = Math.pow(10, pr.currency_minor_unit ?? 2);
      const fmt = v => v ? `${pr.currency_prefix || ''}${(Number(v) / unit).toLocaleString('en-IN')}${pr.currency_suffix || ''}` : '';
      out.push({
        name: strip(p.name),
        what: (p.categories || []).map(c => strip(c.name)).slice(0, 3).join(', '),
        benefits: strip(p.short_description || p.description).slice(0, 240),
        price: fmt(pr.price),
        offer: pr.regular_price && pr.sale_price && pr.sale_price !== pr.regular_price ? `was ${fmt(pr.regular_price)}` : '',
        url: p.permalink || ''
      });
    }
    if (j.length < 100) break;
  }
  return out;
}

function jsonld(html){
  const found = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)){
    try {
      const walk = x => { if (!x || typeof x !== 'object') return; if (Array.isArray(x)) return x.forEach(walk); const t = [].concat(x['@type'] || []); if (t.includes('Product') || t.includes('Service') || t.includes('Offer')) found.push(x); Object.values(x).forEach(walk); };
      walk(JSON.parse(m[1].trim()));
    } catch (e) {}
  }
  return found.slice(0, 40).map(x => ({ name: x.name, description: String(x.description || '').slice(0, 200), price: x.offers?.price || x.offers?.[0]?.price || '', currency: x.offers?.priceCurrency || x.offers?.[0]?.priceCurrency || '' }));
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!(await authed(req))) return deny(res);
  let u;
  try { u = new URL(/^https?:\/\//i.test(req.body?.url || '') ? req.body.url : 'https://' + (req.body?.url || '')); } catch (e) { return res.status(400).json({ error: 'That website address looks wrong' }); }
  if (!/^https?:$/.test(u.protocol) || PRIVATE.test(u.hostname) || !u.hostname.includes('.')) return res.status(400).json({ error: 'That website address looks wrong' });
  const origin = u.origin;
  try {
    let products = [];
    try { products = await shopify(origin); if (products.length) return res.status(200).json({ source: 'Shopify store', products }); } catch (e) {}
    try { products = await woo(origin); if (products.length) return res.status(200).json({ source: 'WooCommerce store', products }); } catch (e) {}
    const pages = [u.href];
    for (const p of ['/collections/all', '/shop', '/products', '/services', '/our-products']) if (!pages.includes(origin + p)) pages.push(origin + p);
    let text = '', ld = [], title = '', description = '';
    for (const p of pages.slice(0, 4)){
      try {
        const r = await get(p, 9000);
        if (!r.ok) continue;
        const html = await r.text();
        if (!title) title = strip((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
        if (!description) description = strip((html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i) || [])[1] || '');
        ld = ld.concat(jsonld(html));
        const links = [...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => strip(m[2])).filter(t => t && t.length < 60).slice(0, 150).join(' | ');
        text += `\n\n=== PAGE ${p} ===\n${strip(html).slice(0, 9000)}\nLINKS: ${links}`;
      } catch (e) {}
      if (text.length > 24000) break;
    }
    if (!text && !ld.length) return res.status(502).json({ error: 'Could not open the website. It may block automated visits.' });
    res.status(200).json({ source: 'website pages', products: [], text: text.slice(0, 26000), jsonld: ld, title, description });
  } catch (e){
    res.status(500).json({ error: e.message });
  }
}
