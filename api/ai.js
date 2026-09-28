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
    const code = e.code === 'busy' || e.code === 'no_credit' || e.code === 'rate_limited' ? e.code : e.credit ? 'no_credit' : e.badKey ? 'bad_key' : e.status === 429 ? 'rate_limited' : 'upstream_error';
    res.status(code === 'busy' ? 503 : e.status === 429 ? 429 : 502).json({ code, error: e.message });
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
// When Google says a model is overloaded ("high demand", 503), try a sibling model instead of failing.
const BUSY_ALT = { chat: ['gemini-flash-latest', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'], quick: ['gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], default: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'] };   // never fall back to a pricier Pro model
const isBusy = (status, msg) => status === 503 || /high demand|overloaded|unavailable|try again later/i.test(msg || '');
const nap = ms => new Promise(r => setTimeout(r, ms));

// Why a call failed, so the router knows whether another model, the other key, or a short wait can fix it.
const noCredit = (status, msg) => /prepayment|credits? (are )?depleted|credit balance|billing (is )?(not|disabled)|billing account/i.test(msg || '') || status === 402;
const rateLimited = (status, msg) => status === 429 || /quota|RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(msg || '');
const badKey = (status, msg) => /API key not valid|API_KEY_INVALID|permission denied|has been disabled|leaked/i.test(msg || '') || status === 401 || status === 403;
const transient = e => e && (e.busy || e.rate || e.empty || e.net);
let paidDeadUntil = 0;   // paid balance was ₹0 recently: skip it for a while instead of failing on it every call
const BUSY_MSG = "Google's AI is busy right now (on Google's side, not your limit). Lumi retried and switched models but couldn't get through. Try again in a minute.";
async function geminiRouted(prompt, tier, json, search, files, freeMode){
  const paid = process.env.GEMINI_API_KEY, free = process.env.GEMINI_API_KEY_FREE;
  const freeFirst = free && freeMode !== 'off' && (freeMode === 'all' || tier === 'chat' || tier === 'quick');
  const useFree = free && freeMode !== 'off';
  const deadline = Date.now() + (tier === 'chat' ? 14e3 : 150e3);   // stay well inside the function's time limit
  const errs = [], seen = []; let last;
  const pass = async order => {
    for (const [kind, key] of order){
      if (!key) continue;
      if (kind === 'paid' && paidDeadUntil > Date.now() && order.some(([k, x]) => k === 'free' && x)) { errs.push('Paid key: paid credit is ₹0'); continue; }
      try { const out = await gemini(prompt, tier, json, search, files, key, kind, deadline); if (kind === 'free') out.usage.free = true; out.keyUsed = kind; return out; }
      catch (e){
        last = e; seen.push(e); errs.push(`${kind === 'free' ? 'Free key' : 'Paid key'}: ${String(e.message || '').slice(0, 160)}`);
        if (kind === 'paid' && e.credit) paidDeadUntil = Date.now() + 10 * 60e3;
        if (e.hard) throw e;   // the request itself is wrong: the other key would fail the same way
      }
    }
    return null;
  };
  const order = freeFirst ? [['free', free], ['paid', paid]] : [['paid', paid], ...(useFree ? [['free', free]] : [])];
  let out = await pass(order); if (out) return out;
  // Everything was busy or rate-limited: wait a little and try once more (the per-minute limit clears in under a minute).
  const retryOrder = useFree ? [['free', free], ...(paidDeadUntil > Date.now() ? [] : [['paid', paid]])] : [['paid', paid]];
  if (seen.some(transient) && Date.now() + (tier === 'chat' ? 6e3 : 12e3) < deadline){
    await nap(tier === 'chat' ? 3e3 : 10e3);
    seen.length = 0; out = await pass(retryOrder); if (out) return out;
  }
  if (!last) throw Object.assign(new Error('No Gemini key set. Add GEMINI_API_KEY in Vercel.'), { status: 500 });
  if (seen.some(e => e.busy || e.net || e.empty)) throw Object.assign(new Error(BUSY_MSG), { status: 503, code: 'busy' });
  if (seen.some(e => e.rate)) throw Object.assign(new Error(paidDeadUntil > Date.now() ? "The free key is at Google's limit for the moment and paid credit is ₹0. Try again in a minute." : "Lumi hit Google's usage limit for the moment. Try again in a minute."), { status: 429, code: paidDeadUntil > Date.now() ? 'no_credit' : 'rate_limited' });
  if (errs.length > 1) last.message = errs.join(' · ');
  throw last;
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

const noThinkBad = {};   // models that refused thinkingConfig this instance
async function callGemini(model, prompt, json, search, files = [], key = process.env.GEMINI_API_KEY, tier = 'default', noThink = false){
  const r = await fetch(`${GBASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(tier === 'chat' ? 40e3 : 170e3),
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

async function gemini(prompt, tier, json, search, files = [], key = process.env.GEMINI_API_KEY, kind = 'paid', deadline = Date.now() + 150e3){
  const envModel = tier === 'chat' ? (process.env.GEMINI_MODEL_CHAT || 'gemini-flash-lite-latest') : tier === 'quick' ? (process.env.GEMINI_MODEL_FAST || process.env.GEMINI_MODEL) : process.env.GEMINI_MODEL;
  const pk = kind + ':' + tier; const first = picked[pk] || envModel || 'gemini-flash-latest';
  const queue = [first, ...(BUSY_ALT[tier] || BUSY_ALT.default).filter(m => m !== first)].slice(0, 3);
  const tried = new Set(); let lastErr = null, useSearch = search, searchDropped = false;
  while (queue.length){
    const model = queue.shift(); if (tried.has(model)) continue; tried.add(model);
    let noThink = tier === 'chat' && !noThinkBad[model], quick = 0, waited = 0, fail = null;
    for (let step = 0; step < 6; step++){
      let r, j;
      try { ({ r, j } = await callGemini(model, prompt, json, useSearch, files, key, tier, noThink)); }
      catch (e){ fail = Object.assign(new Error('Could not reach Google (' + e.message + ')'), { net: true, status: 502 }); if (!quick++ && Date.now() < deadline){ await nap(1200); continue; } break; }
      const emsg = j?.error?.message || '';
      if (r.ok){
        const c = j.candidates?.[0];
        const text = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
        if (!text){ fail = Object.assign(new Error(`Gemini returned nothing (${c?.finishReason || j.promptFeedback?.blockReason || 'unknown'})`), { empty: true, status: 502 }); break; }   // try a sibling model
        if (model === first) picked[pk] = model;
        const sources = (c?.groundingMetadata?.groundingChunks || []).map(g => g.web).filter(Boolean).map(w => ({ title: w.title || '', uri: w.uri || '' }));
        const u = j.usageMetadata || {};
        return { text, sources, searchDropped, usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), search: useSearch ? 1 : 0, model } };
      }
      // 400 "invalid argument" on the speed setting: ask again without it, and stop sending it to this model
      if (noThink && r.status === 400){ noThinkBad[model] = true; noThink = false; continue; }
      // Search grounding not allowed (free tier / region): carry on without it
      if (useSearch && (r.status === 400 || r.status === 403) && /ground|google_search|search|tool|billing|free tier|not supported|not available|invalid argument/i.test(emsg)){ useSearch = false; searchDropped = true; continue; }
      if (noCredit(r.status, emsg)) throw Object.assign(new Error(emsg || 'Paid credit is ₹0'), { status: 402, credit: true });   // this key has no money: next key
      if (badKey(r.status, emsg)) throw Object.assign(new Error(emsg || 'API key not valid'), { status: r.status, badKey: true });
      if (r.status === 404 || /no longer available|not found|deprecated|retired/i.test(emsg)){   // model retired: its named replacement, else the newest on the account
        const named = [...emsg.matchAll(/models\/(gemini-[\w.\-]+)/g)].map(m => m[1].replace(/[.\-]+$/, '')).find(n => !tried.has(n));
        const next = named || (tier === 'chat' ? (await latestGemini('flash-lite', key)) || (await latestGemini('flash', key)) : await latestGemini('flash', key));
        if (next && !tried.has(next)) queue.unshift(next);
        fail = Object.assign(new Error(emsg), { status: 404, busy: true }); break;
      }
      if (rateLimited(r.status, emsg)){   // free-tier limits are per model, so a sibling model usually still has room
        fail = Object.assign(new Error(emsg || 'Rate limited'), { status: 429, rate: true });
        if (kind === 'paid' && !waited++ && Date.now() + 15e3 < deadline){ const ra = +(r.headers.get('retry-after') || 0); await nap(Math.min(12, ra || 6) * 1000); continue; }
        break;
      }
      if (r.status >= 500 || /high demand|overloaded|unavailable|try again|internal error|deadline/i.test(emsg)){   // Google overloaded or hiccup
        fail = Object.assign(new Error(emsg || `Gemini error ${r.status}`), { status: r.status, busy: true });
        if (!quick++ && Date.now() < deadline){ await nap(1500); continue; }
        break;
      }
      throw Object.assign(new Error(emsg || `Gemini error ${r.status}`), { status: r.status, hard: r.status === 400 });   // the request itself is wrong
    }
    lastErr = fail || lastErr;
    if (Date.now() > deadline) break;
  }
  throw lastErr || Object.assign(new Error('No working Gemini model found.'), { status: 502, busy: true });
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
  const models = [model, ...BUSY_ALT.chat.filter(m => m !== model)].slice(0, 3);
  for (const [kind, key] of order){
    if (!key) continue;
    if (kind === 'paid' && paidDeadUntil > Date.now()) continue;   // known ₹0: the normal path reports it if nothing else works
    for (const [mi, model] of models.entries()){
    let busy = false;
    const tries = [[!noThinkBad[model], search], [false, search], ...(search ? [[false, false]] : [])].filter((t, i, a) => a.findIndex(u => u[0] === t[0] && u[1] === t[1]) === i);
    for (const [noThink, useSearch] of tries){
      let r;
      try {
        r = await fetch(`${GBASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', signal: AbortSignal.timeout(45e3), headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], ...(useSearch ? { tools: [{ google_search: {} }] } : {}),
            generationConfig: { temperature: 0.3, maxOutputTokens: 8192, ...(noThink ? { thinkingConfig: { thinkingBudget: 0 } } : {}), ...(json && !useSearch ? { responseMimeType: 'application/json' } : {}) } }) });
      } catch (e) { busy = true; break; }
      if (!r.ok){ const et = await r.text().catch(() => ''); if (r.status === 400){ if (noThink) noThinkBad[model] = true; continue; } if (noCredit(r.status, et)){ if (kind === 'paid') paidDeadUntil = Date.now() + 10 * 60e3; break; } if (isBusy(r.status, et) || rateLimited(r.status, et) || r.status >= 500 || r.status === 404){ busy = true; if (mi === 0 && r.status !== 429) await nap(800); } break; }   // 'invalid argument': retry without thinking setting, then without search; else next key
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
      try { await recordUsage(brandId, { in: usage.promptTokenCount || 0, out: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0), search: useSearch ? 1 : 0, model, free: kind === 'free' }, 'gemini'); } catch (e) {}
      return true;
    }
    if (!busy) break;   // only overload moves on to a sibling model; other errors go to the next key
    }
  }
  return false;
}
