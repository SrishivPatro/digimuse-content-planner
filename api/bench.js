import { authed, deny } from './_lib.js';

const TOKEN = process.env.APIFY_TOKEN;
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const META_IG = process.env.META_IG_USER_ID;
const GV = process.env.META_GRAPH_VERSION || 'v25.0';
const GBASE_META = process.env.META_BASE || 'https://graph.facebook.com';
const BASE = process.env.APIFY_BASE || 'https://api.apify.com';
const IG_ACTOR = process.env.APIFY_IG_ACTOR || 'apify~instagram-scraper';
const LI_ACTOR = process.env.APIFY_LI_ACTOR || 'harvestapi~linkedin-company-posts';

async function runActor(actor, input, secs = 200){
  const r = await fetch(`${BASE}/v2/acts/${actor}/run-sync-get-dataset-items?timeout=${secs}&clean=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(input), signal: AbortSignal.timeout((secs + 20) * 1000)
  });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && (j.error?.message || j.message)) || `Apify error ${r.status}`);
  return Array.isArray(j) ? j : [];
}
const igUrl = h => { const x = String(h || '').trim(); if (!x) return ''; if (/instagram\.com/i.test(x)) return x.startsWith('http') ? x : 'https://' + x; return 'https://www.instagram.com/' + x.replace(/^@/, '').replace(/\/$/, '') + '/'; };
const liUrl = h => { const x = String(h || '').trim(); if (!x) return ''; if (/linkedin\.com/i.test(x)) return x.startsWith('http') ? x : 'https://' + x; return 'https://www.linkedin.com/company/' + x.replace(/^@/, '') + '/'; };
const cut = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);

const igHandle = h => { const x = String(h || '').trim(); const m = x.match(/instagram\.com\/([A-Za-z0-9._]+)/i); return (m ? m[1] : x).replace(/^@/, '').replace(/\/.*$/, ''); };
async function metaGet(fields){
  const url = `${GBASE_META}/${GV}/${META_IG}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(META_TOKEN)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error?.message || `Instagram API error ${r.status}`);
  return j;
}
export async function instagramMeta(handle, since){
  const u = igHandle(handle); if (!u) return { posts: [], followers: 0 };
  const base = `followers_count,media_count,username,name`;
  const mf = f => `business_discovery.username(${u}){${base},media.limit(50){${f}}}`;
  let j;
  try { j = await metaGet(mf('caption,like_count,comments_count,timestamp,permalink,media_type,media_product_type,view_count')); }
  catch (e){ if (/view_count|nonexisting field|Tried accessing/i.test(e.message)) j = await metaGet(mf('caption,like_count,comments_count,timestamp,permalink,media_type,media_product_type')); else throw e; }
  const bd = j.business_discovery || {};
  const posts = (bd.media?.data || []).map(m => ({
    platform: 'Instagram', date: String(m.timestamp || '').slice(0, 10),
    type: m.media_product_type === 'REELS' || m.media_type === 'VIDEO' ? 'Reel' : m.media_type === 'CAROUSEL_ALBUM' ? 'Carousel' : 'Static',
    text: cut(m.caption, 400), likes: +m.like_count || 0, comments: +m.comments_count || 0, shares: 0, views: +m.view_count || 0, url: m.permalink || ''
  })).filter(p => !p.date || p.date >= since);
  return { posts, followers: +bd.followers_count || 0 };
}
async function instagram(c, since){
  const url = igUrl(c.instagram); if (!url) return [];
  const items = await runActor(IG_ACTOR, { directUrls: [url], resultsType: 'posts', resultsLimit: 40, onlyPostsNewerThan: since, addParentData: false });
  return items.filter(p => p && (p.timestamp || p.url) && !p.error).map(p => ({
    platform: 'Instagram', date: String(p.timestamp || '').slice(0, 10),
    type: p.productType === 'clips' || p.type === 'Video' ? 'Reel' : p.type === 'Sidecar' ? 'Carousel' : 'Static',
    text: cut(p.caption, 400), likes: +p.likesCount || 0, comments: +p.commentsCount || 0, shares: 0, views: +(p.videoPlayCount || p.videoViewCount) || 0, url: p.url || ''
  })).filter(p => !p.date || p.date >= since);
}
async function linkedin(c, since){
  const url = liUrl(c.linkedin); if (!url) return [];
  const items = await runActor(LI_ACTOR, { targetUrls: [url], maxPosts: 40, postedLimitDate: since, scrapeReactions: false, scrapeComments: false });
  return items.filter(p => p && (p.content || p.linkedinUrl)).map(p => ({
    platform: 'LinkedIn', date: String(p.postedAt?.date || p.postedAt?.timestamp || '').slice(0, 10),
    type: (p.postImages?.length > 1 || p.document) ? 'Carousel' : p.postVideo || p.video ? 'Video' : p.postImages?.length ? 'Static' : 'Text',
    text: cut(p.content, 400), likes: +(p.engagement?.likes ?? p.engagement?.reactions?.length) || 0, comments: +p.engagement?.comments || 0, shares: +p.engagement?.shares || 0, views: 0, url: p.linkedinUrl || ''
  })).filter(p => !p.date || p.date >= since);
}

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authed(req)) return deny(res);
  const { competitors = [], days = 30, check } = req.body || {};
  const hasMeta = !!(META_TOKEN && META_IG);
  if (check){
    if (!hasMeta) return res.status(200).json({ ok: false, error: 'META_ACCESS_TOKEN and META_IG_USER_ID are not set in Vercel yet.' });
    try { const me = await metaGet('username,followers_count'); const t = await instagramMeta(check, '1970-01-01'); return res.status(200).json({ ok: true, account: me.username, test: igHandle(check), testFollowers: t.followers, testPosts: t.posts.length }); }
    catch (e){ return res.status(200).json({ ok: false, error: e.message }); }
  }
  if (!hasMeta && !TOKEN) return res.status(200).json({ source: 'none', note: 'Add the Instagram API keys in Vercel to pull real Instagram posts.', results: competitors.slice(0, 8).map(c => ({ name: c.name, posts: [], errors: [] })) });
  const since = new Date(Date.now() - Math.min(90, Math.max(7, +days || 30)) * 86400000).toISOString().slice(0, 10);
  const list = competitors.slice(0, 8);
  const results = await Promise.all(list.map(async c => {
    const out = { name: c.name, posts: [], errors: [] };
    const igP = hasMeta ? instagramMeta(c.instagram, since).then(x => { out.followers = x.followers; return x.posts; }) : TOKEN ? instagram(c, since) : Promise.resolve([]);
    const liP = TOKEN ? linkedin(c, since) : Promise.resolve([]);
    const [ig, li] = await Promise.allSettled([igP, liP]);
    if (ig.status === 'fulfilled') out.posts.push(...ig.value); else if (c.instagram) out.errors.push('Instagram: ' + ig.reason.message);
    if (li.status === 'fulfilled') out.posts.push(...li.value); else if (c.linkedin && TOKEN) out.errors.push('LinkedIn: ' + li.reason.message);
    out.posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return out;
  }));
  res.status(200).json({ source: hasMeta ? 'meta' : 'apify', since, results });
}
