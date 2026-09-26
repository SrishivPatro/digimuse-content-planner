import { authed, deny } from './_lib.js';

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!authed(req)) return deny(res);
  const { prompt, tier = 'default', json = false } = req.body || {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt' });
  const provider = (process.env.AI_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'claude' : '')).toLowerCase();
  try {
    let text;
    if (provider === 'gemini') text = await gemini(prompt, tier, json);
    else if (provider === 'claude') text = await claude(prompt, tier);
    else return res.status(500).json({ code: 'sampling_disabled', error: 'No AI key set. Add GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Vercel, then redeploy.' });
    res.status(200).json({ text });
  } catch (e){
    const limited = e.status === 429;
    res.status(limited ? 429 : 502).json({ code: limited ? 'rate_limited' : 'upstream_error', error: e.message });
  }
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

async function callGemini(model, prompt, json){
  const r = await fetch(`${GBASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 32768, ...(json ? { responseMimeType: 'application/json' } : {}) }
    })
  });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}

async function gemini(prompt, tier, json){
  const envModel = tier === 'quick' ? (process.env.GEMINI_MODEL_FAST || process.env.GEMINI_MODEL) : process.env.GEMINI_MODEL;
  let model = picked[tier] || envModel || 'gemini-flash-latest';
  const tried = new Set();
  for (let attempt = 0; attempt < 3; attempt++){
    tried.add(model);
    const { r, j } = await callGemini(model, prompt, json);
    if (r.ok){
      picked[tier] = model;
      const c = j.candidates?.[0];
      const text = (c?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
      if (!text) throw Object.assign(new Error(`Gemini returned nothing (${c?.finishReason || j.promptFeedback?.blockReason || 'unknown'})`), { status: 502 });
      return text;
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

async function claude(prompt, tier){
  const model = tier === 'quick' ? (process.env.CLAUDE_MODEL_FAST || 'claude-haiku-4-5-20251001') : (process.env.CLAUDE_MODEL || 'claude-sonnet-5');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Claude error ${r.status}`), { status: r.status });
  return (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
}
