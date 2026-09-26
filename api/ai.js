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

async function gemini(prompt, tier, json){
  const model = tier === 'quick' ? (process.env.GEMINI_MODEL_FAST || process.env.GEMINI_MODEL || 'gemini-2.5-flash') : (process.env.GEMINI_MODEL || 'gemini-2.5-flash');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.8, maxOutputTokens: 32768, ...(json ? { responseMimeType: 'application/json' } : {}) }
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error?.message || `Gemini error ${r.status}`), { status: r.status });
  const c = j.candidates?.[0];
  const text = (c?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw Object.assign(new Error(`Gemini returned nothing (${c?.finishReason || j.promptFeedback?.blockReason || 'unknown'})`), { status: 502 });
  return text;
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
