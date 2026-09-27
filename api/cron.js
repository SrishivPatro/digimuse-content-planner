import crypto from 'node:crypto';
import { authed, redis, pipeline, PREFIX, recordUsage, logActivity, safeEq } from './_lib.js';
import { runAI, freeModeOf } from './ai.js';

// Weekly trend alert. Vercel Cron calls GET /api/cron every Monday (see vercel.json) with
// "Authorization: Bearer <CRON_SECRET>". A signed-in user can run one brand now with ?brand=<id>.
const loose = t => { const s = String(t || '').trim(); try { return JSON.parse(s); } catch (e) {} const f = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (f){ try { return JSON.parse(f[1]); } catch (e) {} } const i = s.search(/[\[{]/), j = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']')); if (i >= 0 && j > i){ try { return JSON.parse(s.slice(i, j + 1)); } catch (e) {} } return null; };
const str = v => v == null ? '' : String(v);
const arr = v => Array.isArray(v) ? v : [];

function prompt(b){
  const ch = Object.entries(b.channels || {}).filter(([, v]) => v?.on).map(([k]) => k);
  const t = b.trendAlert || {};
  const prods = arr(b.brain?.products).slice(0, 15).map(p => p.name).join(', ');
  const pillars = arr(b.pillars).filter(p => p.active !== false).map(p => p.name).join(', ');
  return `Today is ${new Date().toLocaleDateString('en-IN', {weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'Asia/Kolkata'})} (India time).
You are the lead social media strategist at a top Indian digital agency. Be specific and brand-true, no clichés.

BRAND: ${b.name} · ${b.industry || ''} ${b.sub ? '/ ' + b.sub : ''} · ${b.type || ''} · ${b.price || ''}
About: ${str(b.desc).slice(0, 300)}
Audience: ${b.audience?.age || ''} ${b.audience?.gender || ''}, ${b.audience?.geo || 'India'} ${b.audience?.tier || ''}; languages ${b.audience?.languages || 'English'}
Channels: ${ch.join(', ') || 'Instagram'} · Products: ${prods || 'n/a'} · Pillars: ${pillars || 'n/a'}
Voice: ${b.voice?.adjectives || ''}; avoid: ${b.voice?.avoid || ''}; compliance: ${b.voice?.compliance || 'none'}
${t.focus ? 'Team focus: ' + t.focus : ''}

TASK: Weekly trend radar for the last 7 days (today is ${new Date().toDateString()}), region ${b.audience?.geo || 'India'}.
Use web search. Map what is trending on ${ch.join(' and ') || 'Instagram'}: formats, reel styles, audio or memes, conversation topics, cultural and news moments, festivals coming up in the next 2 weeks. Only keep trends that fit this brand without looking forced. Only give a "url" if it appeared in your search results; otherwise leave it empty. Never invent numbers.
Then write ${Math.max(3, Math.min(12, +t.n || 6))} content ideas for this brand that use these trends, each tied to a trend.
Reply with only JSON:
{"headline":"","summary":"3-5 lines","trends":[{"name":"","what":"","platform":"","format":"","example":"","url":"","howToUse":"","shelfLife":"days | weeks | months","fit":"High | Medium | Low"}],"opportunities":[""],"avoid":[""],"ideas":[{"title":"","format":"Reel | Carousel | Static | Story | Video | Text","channel":"","pillar":"","hook":"","why":"","urgency":"This week | This month | Evergreen"}]}`;
}

async function runBrand(id, b, by){
  let freeMode = 'off'; if (process.env.GEMINI_API_KEY_FREE){ try { freeMode = await freeModeOf(); } catch (e) { freeMode = 'all'; } }
  const out = await runAI(prompt(b), { search: true, freeMode });
  if (!out) throw new Error('Lumi has no key set (add GEMINI_API_KEY in Vercel)');
  try { await recordUsage(id, out.usage, out.provider); } catch (e) {}
  const data = loose(out.text);
  if (!data || typeof data !== 'object') throw new Error('Lumi’s reply was not readable');
  const rid = crypto.randomBytes(8).toString('hex');
  const report = { type: 'research', kind: 'trends', auto: true, brandId: id, at: Date.now(), days: 7, platform: 'Weekly trend alert', region: b.audience?.geo || 'India', focus: str(b.trendAlert?.focus), n: +b.trendAlert?.n || 6, data, sources: arr(out.sources).slice(0, 20), searched: !out.searchDropped, by: '', saved: [] };
  const FORMATS = ['Static', 'Carousel', 'Reel', 'Story', 'Video', 'Text'];
  const ideas = arr(data.ideas).filter(x => x?.title).map(x => ({ text: str(x.title) + (x.hook ? ' — Hook: ' + x.hook : ''), why: 'Weekly trend alert: ' + str(x.why) + (x.urgency ? ' (' + x.urgency + ')' : ''), format: FORMATS.includes(x.format) ? x.format : '', channel: str(x.channel), pillar: str(x.pillar), ai: true, at: Date.now(), used: false, by: '' }));
  const cur = JSON.parse(await redis(['HGET', PREFIX + 'brands', id]) || '{}');
  cur.ideas = arr(cur.ideas).concat(ideas).slice(-300);
  cur.trendAlert = { ...(cur.trendAlert || {}), lastRun: Date.now(), lastReport: rid };
  report.saved = ideas.map((_, i) => i);
  await pipeline([['HSET', PREFIX + 'reports', rid, JSON.stringify(report)], ['HSET', PREFIX + 'brands', id, JSON.stringify(cur)], ['INCR', PREFIX + 'ver']]);
  try { await logActivity({ name: by || 'Weekly trend alert' }, 'reports', rid, 'set', { name: 'Trend radar: ' + b.name }, null); } catch (e) {}
  return { id, name: b.name, ideas: ideas.length, report: rid };
}

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET;
  const isCron = !!secret && safeEq(req.headers.authorization || '', 'Bearer ' + secret);
  const one = String(req.query?.brand || '');
  const user = isCron ? null : await authed(req);
  if (!isCron && !(user && one)) return res.status(401).json({ error: isCron ? 'Bad cron secret' : 'Sign in required (or set CRON_SECRET for the weekly job)' });
  try {
    const flat = await redis(['HGETALL', PREFIX + 'brands']) || []; const brands = [];
    for (let i = 0; i < flat.length; i += 2){ try { brands.push([flat[i], JSON.parse(flat[i + 1])]); } catch (e) {} }
    const todo = one ? brands.filter(([id]) => id === one) : brands.filter(([, b]) => b.trendAlert?.on);
    if (one && !todo.length) return res.status(404).json({ error: 'Brand not found' });
    const done = [], failed = [];
    for (let i = 0; i < todo.length; i += 3){
      const rs = await Promise.allSettled(todo.slice(i, i + 3).map(([id, b]) => runBrand(id, b, user?.name)));
      rs.forEach((r, k) => r.status === 'fulfilled' ? done.push(r.value) : failed.push({ name: todo[i + k][1].name, error: r.reason?.message || 'failed' }));
    }
    res.status(200).json({ ok: true, ran: done.length, done, failed });
  } catch (e){ res.status(500).json({ error: e.message }); }
}
