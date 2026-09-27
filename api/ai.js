import { authed, deny, recordUsage } from './_lib.js';

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!(await authed(req))) return deny(res);
  const { prompt, tier = 'default', json = false, search = false, brandId = '', files = [] } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt' });
  const fl = (Array.isArray(files) ? files : []).filter(f => f && /^(application\/pdf|image\/(png|jpe?g|webp))$/.test(f.mime) && typeof f.data === 'string').slice(0, 4);
  try {
    const out = await runAI(prompt, { tier, json, search: !!search, files: fl });
    if (!out) return res.status(500).json({ code: 'sampling_disabled', error: 'No AI key set. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Vercel, then redeploy.' });
    try { await recordUsage(brandId, out.usage, out.provider); } catch (e) {}
    delete out.usage;
    res.status(200).json(out);
  } catch (e){
    const limited = e.status === 429;
    res.status(limited ? 429 : 502).json({ code: limited ? 'rate_limited' : 'upstream_error', error: e.message });
  }
}

export async function runAI(prompt, { tier = 'default', json = false, search = false, files = [] } = {}){
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : '')).toLowerCase();
  if (provider === 'gemini') return { ...(await gemini(prompt, tier, json, search, files)), provider };
  if (provider === 'claude') return { ...(await claude(prompt, tier, search, files)), provider };
  return null;
}

const GBASE = 'https://generativelanguage.googleapis.com/v1beta';
const picked = {};

async function latestGemini(kind){
  const r = await fetch(`${GBASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY } });
  const j = await r.json().catch(() => ({}));
  const ver = n => (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
  const ok = (j.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => new RegExp(`^gemini-[\\d.]+-${kind}$`).test(n))
    .sort((a, b) => parseFloat(ver(b)) - parseFloat(ver(a)));
  return ok[0] || null;
}

async function callGemini(model, prompt, json, search, files = []){
  const r = await fetch(`${GBASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [...files.map(f => ({ inline_data: { mime_type: f.mime, data: f.data } })), { text: prompt }] }],
      ...(search ? { tools: [{ google_search: {} }] } : {}),
      generationConfig: { temperature: 0.9, maxOutputTokens: 32768, ...(json && !search ? { responseMimeType: 'application/json' } : {}) }
    })
  });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

async function gemini(prompt, tier, json, search, files = []){
  const envModel = tier === 'quick' ? (process.env.GEMINI_MODEL_FAST || process.env.GEMINI_MODEL) : process.env.GEMINI_MODEL;
  let model = picked[tier] || envModel || 'gemini-flash-latest';
  const tried = new Set();
  let useSearch = search, waits = 0, searchDropped = false;
  for (let attempt = 0; attempt < 6; attempt++){
    tried.add(model);
    const { r, j } = await callGemini(model, prompt, json, useSearch, files);
    const emsg = j?.error?.message || '';
    // Free keys cannot use Google Search grounding: carry on without it.
    if (!r.ok && useSearch && (r.status === 400 || r.status === 403) && /ground|google_search|search|tool|billing|free tier|not supported|not available/i.test(emsg)){ useSearch = false; searchDropped = true; continue; }
    // Rate limit (free tier is ~10 requests/minute): wait and retry a couple of times.
    if (r.status === 429 && waits < 2){ const ra = +(r.headers.get('retry-after') || 0); await new Promise(res => setTimeout(res, Math.min(30, ra || 12 * (waits + 1)) * 1000)); waits++; attempt--; continue; }
    if (r.ok){
      picked[tier] = model;
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
    const next = named || await latestGemini('flash');
    if (!next || tried.has(next)) throw Object.assign(new Error(msg + ' Set GEMINI_MODEL in Vercel to a current model name.'), { status: 502 });
    model = next;
  }
  throw Object.assign(new Error('No working Gemini model found. Set GEMINI_MODEL in Vercel.'), { status: 502 });
}

async function claude(prompt, tier, search, files = []){
  const model = tier === 'quick' ? (process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001') : (process.env.CLAUDE_MODEL || 'claude-sonnet-5');
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
