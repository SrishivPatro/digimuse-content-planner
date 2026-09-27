import { authed, deny, recordUsage, redis, pipeline, PREFIX } from './_lib.js';

// Chat with Lumi runs on the lite model and has a per-person daily limit (admins set it on the Team page).
// Free key (GEMINI_API_KEY_FREE, a project without billing) runs text first; the paid key covers images, overflow and fallback.
// Admin setting freeMode: 'all' (free first for all text), 'light' (free first for chat and quick tasks), 'off'.
export const freeModeOf = async () => { const v = await redis(['HGET', PREFIX + 'settings', 'freeMode']); return ['all', 'light', 'off'].includes(v) ? v : 'all'; };
export const chatLimitOf = async () => { const v = +(await redis(['HGET', PREFIX + 'settings', 'chatLimit'])); return Number.isFinite(v) && v >= 0 && v !== 0 ? v : (+process.env.LUMI_CHAT_DAILY || 40); };
const istDay = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default async function handler(req, res){
  if (req.method === 'GET' && req.query?.test){   // admins: check each Gemini key with a tiny request
    const me0 = await authed(req); if (!me0) return deny(res); if (me0.role !== 'admin') return res.status(403).json({ error: 'Admins only' });
    const one = async key => { if (!key) return { set: false };
      try { const r = await fetch(`${GBASE}/models/${encodeURIComponent(process.env.GEMINI_MODEL_CHAT || 'gemini-flash-lite-latest')}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with: ok' }] }], generationConfig: { maxOutputTokens: 5 } }) });
        const j = await r.json().catch(() => ({})); return { set: true, ok: r.ok, status: r.status, msg: r.ok ? 'Working' : (j.error?.message || 'Error ' + r.status).slice(0, 300) }; }
      catch (e){ return { set: true, ok: false, msg: e.message }; } };
    const [free, paid] = await Promise.all([one(process.env.GEMINI_API_KEY_FREE), one(process.env.GEMINI_API_KEY)]);
    const same = !!(process.env.GEMINI_API_KEY_FREE && process.env.GEMINI_API_KEY_FREE === process.env.GEMINI_API_KEY);
    return res.status(200).json({ free, paid, same });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const me = await authed(req); if (!me) return deny(res);
  const { prompt, tier = 'default', json = false, search = false, brandId = '', files = [], stream = false } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt' });
  let chatLeft, freeMode = 'off', modeRaw;
  try {
    // one round trip: key mode (+ chat limit and today's counter for chat)
    const k = PREFIX + 'chat:' + String(me.username || 'owner').slice(0, 80) + ':' + istDay();
    const out = await pipeline(tier === 'chat' ? [['HGET', PREFIX + 'settings', 'freeMode'], ['HGET', PREFIX + 'settings', 'chatLimit'], ['INCR', k], ['EXPIRE', k, 172800]] : [['HGET', PREFIX + 'settings', 'freeMode']]);
    modeRaw = out[0];
    if (tier === 'chat'){ const v = +out[1]; const lim = Number.isFinite(v) && v > 0 ? v : (+process.env.LUMI_CHAT_DAILY || 40); const n = +out[2] || 1;
      if (n > lim) return res.status(429).json({ code: 'chat_limit', error: `You've used today's ${lim} Lumi chat messages. The limit resets at midnight; your admin can change it on the Team page.` });
      chatLeft = lim - n; }
  } catch (e) {}
  if (process.env.GEMINI_API_KEY_FREE) freeMode = ['all', 'light', 'off'].includes(modeRaw) ? modeRaw : 'all';
  if (stream && tier === 'chat' && (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_FREE) && (process.env.AI_PROVIDER || 'gemini').toLowerCase() === 'gemini'){
    const started = await streamChat(res, prompt, json, !!search, freeMode, chatLeft, brandId);
    if (started) return;   // otherwise fall through to the normal (non-streaming) path
  }
  const fl = (Array.isArray(files) ? files : []).filter(f => f && /^(application\/pdf|image\/(png|jpe?g|webp))$/.test(f.mime) && typeof f.data === 'string').slice(0, 4);
  try {
    const out = await runAI(prompt, { tier, json, search: !!search, files: fl, freeMode });
    if (!out) return res.status(500).json({ code: 'sampling_disabled', error: 'No AI key set. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Vercel, then redeploy.' });
    const usage = out.usage; delete out.usage; if (chatLeft !== undefined) out.chatLeft = chatLeft;
    res.status(200).json(out);   // reply first; bookkeeping after
    try { await recordUsage(brandId, usage, out.provider); } catch (e) {}
  } catch (e){
    const limited = e.status === 429;
    res.status(limited ? 429 : 502).json({ code: limited ? 'rate_limited' : 'upstream_error', error: e.message });
  }
}

export async function runAI(prompt, { tier = 'default', json = false, search = false, files = [], freeMode = 'off' } = {}){
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_FREE ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : '')).toLowerCase();
  if (provider === 'gemini') return { ...(await geminiRouted(prompt, tier, json, search, files, freeMode)), provider };
  if (provider === 'claude') return { ...(await claude(prompt, tier, search, files)), provider };
  return null;
}

const GBASE = 'https://generativelanguage.googleapis.com/v1beta';
const picked = {};
const billingErr = e => /prepayment|credit|billing|quota|exceeded|RESOURCE_EXHAUSTED|permission|API key not valid|disabled/i.test(String(e?.message || '')) || [401, 402, 403, 429].includes(e?.status);

async function geminiRouted(prompt, tier, json, search, files, freeMode){
  const paid = process.env.GEMINI_API_KEY, free = process.env.GEMINI_API_KEY_FREE;
  const freeFirst = free && freeMode !== 'off' && (freeMode === 'all' || tier === 'chat' || tier === 'quick');
  const order = freeFirst ? [['free', free], ['paid', paid]] : [['paid', paid], ...(free && freeMode !== 'off' ? [['free', free]] : [])];
  let last; const errs = [];
  for (const [kind, key] of order){
    if (!key) continue;
    try { const out = await gemini(prompt, tier, json, search, files, key, kind); if (kind === 'free') out.usage.free = true; out.keyUsed = kind; return out; }
    catch (e){ errs.push(`${kind === 'free' ? 'Free key' : 'Paid key'}: ${String(e.message || '').slice(0, 160)}`); last = e; if (kind === 'paid' && !billingErr(e)) throw e; }   // free key busy/limited, or paid key out of credit: try the other key
  }
  if (last && errs.length > 1) last.message = errs.join(' · ');
  throw last || Object.assign(new Error('No Gemini key set. Add GEMINI_API_KEY in Vercel.'), { status: 500 });
}

async function latestGemini(kind, key = process.env.GEMINI_API_KEY){
  const r = await fetch(`${GBASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  const j = await r.json().catch(() => ({}));
  const ver = n => (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
  const ok = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => new RegExp(`^gemini-[\\d.]+-${kind}$`).test(n))
    .sort((a, b) => parseFloat(ver(b)) - parseFloat(ver(a)));
  return ok[0] || null;
}

async function callGemini(model, prompt, json, search, files = [], key = process.env.GEMINI_API_KEY, tier = 'default', noThink = false){
  const r = await fetch(`${GBASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [...files.map(f => ({ inline_data: { mime_type: f.mime, data: f.data } })), { text: prompt }] }],
      ...(search ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { temperature: tier === 'chat' ? 0.3 : 0.9, maxOutputTokens: 32768, ...(noThink ? { thinkingConfig: { thinkingBudget: 0 } } : {}), ...(json && !search ? { responseMimeType: 'application/json' } : {}) }
    })
  });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

async function gemini(prompt, tier, json, search, files = [], key = process.env.GEMINI_API_KEY, kind = 'paid'){
  const envModel = tier === 'chat' ? (process.env.GEMINI_MODEL_CHAT || 'gemini-flash-lite-latest') : tier === 'quick' ? (process.env.GEMINI_MODEL_FAST || process.env.GEMINI_MODEL) : process.env.GEMINI_MODEL;
  const pk = kind + ':' + tier; let model = picked[pk] || envModel || 'gemini-flash-latest';
  const tried = new Set();
  let useSearch = search, waits = 0, searchDropped = false, noThink = tier === 'chat';
  for (let attempt = 0; attempt < 6; attempt++){
    tried.add(model);
    const { r, j } = await callGemini(model, prompt, json, useSearch, files, key, tier, noThink);
    const emsg = j?.error?.message || '';
    if (!r.ok && noThink && r.status === 400 && /think/i.test(emsg)){ noThink = false; attempt--; continue; }   // model doesn't take the setting: ask again without it
    // Free keys cannot use Google Search grounding: carry on without it.
    if (!r.ok && useSearch && (r.status === 400 || r.status === 403) && /ground|google_search|search|tool|billing|free tier|not supported|not available/i.test(emsg)){ useSearch = false; searchDropped = true; continue; }
    // Rate limit (free tier is ~10 requests/minute): wait and retry a couple of times.
    if (r.status === 429 && kind === 'free') throw Object.assign(new Error(j?.error?.message || 'Free key is busy'), { status: 429 });   // don't wait: the paid key takes over
    if (r.status === 429 && /prepayment|credit|billing|quota exceeded for .*per ?day|per day/i.test(emsg)) throw Object.assign(new Error(emsg), { status: 429 });   // empty balance or daily cap: waiting won't help
    if (r.status === 429 && waits < 2){ const ra = +(r.headers.get('retry-after') || 0); await new Promise(res => setTimeout(res, Math.min(30, ra || 12 * (waits + 1)) * 1000)); waits++; attempt--; continue; }
    if (r.ok){
      picked[pk] = model;
      const c = j.candidates?.[0];
      const text = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (!text) throw Object.assign(new Error(`Gemini returned nothing (${c?.finishReason || j.promptFeedback?.blockReason || 'unknown'})`), { status: 502 });
      const sources = (c?.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ title: w.title || '', uri: w.uri || '' }));
      const u = j.usageMetadata || {};
      return { text, sources, searchDropped, usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), search: useSearch ? 1 : 0, model } };
    }
    const msg = j.error?.message || `Gemini error ${r.status}`;
    const retired = r.status === 404 || /no longer available|not found|deprecated|not supported|retired/i.test(msg);
    if (!retired) throw Object.assign(new Error(msg), { status: r.status });
    // Google retired this model: use the replacement it names, else the newest flash model on the account.
    const named = [...msg.matchAll(/models\/(gemini-[\w.\-]+)/g)].map(m => m[1].replace(/[.\-]+$/, '')).find(n => !tried.has(n));
    const next = named || (tier === 'chat' ? (await latestGemini('flash-lite', key)) || (await latestGemini('flash', key)) : await latestGemini('flash', key));
    if (!next || tried.has(next)) throw Object.assign(new Error(msg + ' Set GEMINI_MODEL in Vercel to a current model name.'), { status: 502 });
    model = next;
  }
  throw Object.assign(new Error('No working Gemini model found. Set GEMINI_MODEL in Vercel.'), { status: 502 });
}

async function claude(prompt, tier, search, files = []){
  const model = tier === 'quick' || tier === 'chat' ? (process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001') : (process.env.CLAUDE_MODEL || 'claude-sonnet-5');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: 'user', content: files.length ? [...files.map(f => f.mime === 'application/pdf' ? { type: 'document', source: { type: 'base64', media_type: f.mime, data: f.data } } : { type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data } }), { type: 'text', text: prompt }] : prompt }], ...(search ? { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }] } : {}) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Claude error ${r.status}`), { status: r.status });
  const blocks = j.content || [];
  const text = blocks.filter(x => x.type === 'text').map(x => x.text).join('');
  const sources = blocks.filter(x => x.type === 'web_search_tool_result' && Array.isArray(x.content)).flatMap(x => x.content).filter(x => x.url).map(x => ({ title: x.title || '', uri: x.url }));
  const u = j.usage || {};
  return { text, sources, usage: { in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0), out: u.output_tokens || 0, search: u.server_tool_use?.web_search_requests || 0, model } };
}

// Streams Chat with Lumi as NDJSON lines: {"d":"text chunk"} … then {"done":true,"sources":[],"chatLeft":n}.
// Returns false if no key could start a stream (caller then uses the normal path, which handles retries and model changes).
async function streamChat(res, prompt, json, search, freeMode, chatLeft, brandId){
  const paid = process.env.GEMINI_API_KEY, free = process.env.GEMINI_API_KEY_FREE;
  const order = free && freeMode !== 'off' ? [['free', free], ['paid', paid]] : [['paid', paid], ...(free && freeMode !== 'off' ? [['free', free]] : [])];
  const model = picked['free:chat'] || picked['paid:chat'] || process.env.GEMINI_MODEL_CHAT || 'gemini-flash-lite-latest';
  for (const [kind, key] of order){
    if (!key) continue;
    for (const noThink of [true, false]){
      let r;
      try {
        r = await fetch(`${GBASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], ...(search ? { tools: [{ google_search: {} }] } : {}),
            generationConfig: { temperature: 0.3, maxOutputTokens: 8192, ...(noThink ? { thinkingConfig: { thinkingBudget: 0 } } : {}), ...(json && !search ? { responseMimeType: 'application/json' } : {}) } }) });
      } catch (e) { break; }
      if (!r.ok){ const t = await r.text().catch(() => ''); if (noThink && r.status === 400 && /think/i.test(t)) continue; break; }   // try without the setting, else next key
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const dec = new TextDecoder(); let buf = '', usage = {}, sources = [];
      const reader = r.body.getReader();
      try {
        for (;;){
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true }); let i;
          while ((i = buf.indexOf('\n')) >= 0){
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            let j; try { j = JSON.parse(line.slice(5)); } catch (e) { continue; }
            const c = j.candidates?.[0]; const t = (c?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
            if (t) res.write(JSON.stringify({ d: t }) + '\n');
            if (j.usageMetadata) usage = j.usageMetadata;
            const g = (c?.groundingMetadata?.groundingChunks || []).map(x => x.web).filter(Boolean).map(w => ({ title: w.title || '', uri: w.uri || '' })); if (g.length) sources = g;
          }
        }
      } catch (e) { res.write(JSON.stringify({ error: 'The reply was cut off. Try again.' }) + '\n'); }
      res.end(JSON.stringify({ done: true, sources, ...(chatLeft !== undefined ? { chatLeft } : {}) }) + '\n');
      try { await recordUsage(brandId, { in: usage.promptTokenCount || 0, out: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), search: search ? 1 : 0, model, free: kind === 'free' }, 'gemini'); } catch (e) {}
      return true;
    }
  }
  return false;
}
