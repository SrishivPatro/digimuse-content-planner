import { tokenFor } from './_lib.js';

export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const pw = process.env.TEAM_PASSWORD;
  const { password } = req.body || {};
  if (pw && password !== pw) return res.status(401).json({ error: 'Wrong password' });
  const token = pw ? tokenFor(pw) : '0'.repeat(64);
  res.setHeader('Set-Cookie', `dcp=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  res.status(200).json({ ok: true });
}
