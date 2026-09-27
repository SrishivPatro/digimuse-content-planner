import crypto from 'node:crypto';
import { chatLimitOf, freeModeOf } from './ai.js';
import { authed, deny, redis, PREFIX, USERS, getUser, putUser, userCount, hashPw, checkPw, publicUser, sessionCookie, normU } from './_lib.js';

const UNAME = /^[a-z0-9._@+-]{3,60}$/;
const tempPw = () => { const c = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const b of crypto.randomBytes(12)) s += c[b % c.length]; return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12); };
const okPw = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

export default async function handler(req, res){
  res.setHeader('Cache-Control', 'no-store');
  const me = await authed(req);
  if (!me) return deny(res);
  try {
    if (req.method === 'GET'){
      let chatLimit = 40, freeMode = 'all'; try { chatLimit = await chatLimitOf(); freeMode = await freeModeOf(); } catch (e) {}
      return res.status(200).json({ user: me, users: await userCount(), chatLimit, freeMode, hasFreeKey: !!process.env.GEMINI_API_KEY_FREE, hasPaidKey: !!process.env.GEMINI_API_KEY });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });
    const b = req.body || {}; const a = b.action;

    // ----- any signed-in user -----
    if (a === 'changePassword'){
      if (me.owner) return res.status(400).json({ error: 'The owner login uses TEAM_PASSWORD. Change it in Vercel.' });
      const u = await getUser(me.username);
      if (!u || !checkPw(String(b.old || ''), u.hash)) return res.status(400).json({ error: 'Current password is wrong' });
      if (!okPw(b.password)) return res.status(400).json({ error: 'Use at least 8 characters' });
      if (b.password === b.old) return res.status(400).json({ error: 'Pick a different password' });
      u.hash = hashPw(b.password); u.mustChange = false; u.ver = (u.ver || 0) + 1; await putUser(u);
      res.setHeader('Set-Cookie', sessionCookie(u.username, u.ver));   // other devices are signed out, this one stays in
      return res.status(200).json({ ok: true, user: publicUser(u) });
    }
    if (a === 'linkMe'){
      if (me.owner) return res.status(200).json({ ok: true });
      const u = await getUser(me.username); if (!u) return deny(res);
      u.teamId = String(b.teamId || '').slice(0, 80); await putUser(u);
      return res.status(200).json({ ok: true, user: publicUser(u) });
    }

    // ----- admins only -----
    if (me.role !== 'admin') return res.status(403).json({ error: 'Only admins can manage logins' });
    if (a === 'list'){
      const flat = await redis(['HGETALL', USERS]) || []; const out = [];
      for (let i = 0; i < flat.length; i += 2){ try { const u = JSON.parse(flat[i + 1]); out.push({ ...publicUser(u), disabled: !!u.disabled, lastLogin: u.lastLogin || 0, createdAt: u.createdAt || 0, createdBy: u.createdBy || '' }); } catch (e){} }
      out.sort((x, y) => x.name.localeCompare(y.name));
      return res.status(200).json({ users: out });
    }
    if (a === 'freeMode'){ if (!['all', 'light', 'off'].includes(b.value)) return res.status(400).json({ error: 'Unknown mode' }); await redis(['HSET', PREFIX + 'settings', 'freeMode', b.value]); return res.status(200).json({ ok: true, freeMode: b.value }); }
    if (a === 'chatLimit'){ const v = Math.round(+b.value); if (!(v >= 1 && v <= 1000)) return res.status(400).json({ error: 'Use a number from 1 to 1000' }); await redis(['HSET', PREFIX + 'settings', 'chatLimit', String(v)]); return res.status(200).json({ ok: true, chatLimit: v }); }
    const username = normU(b.username);
    if (a === 'create'){
      if (!UNAME.test(username) || username === 'owner') return res.status(400).json({ error: 'Username: 3-60 characters, letters, numbers and . _ @ + - only (not "owner")' });
      if (await getUser(username)) return res.status(409).json({ error: 'That username is taken' });
      const pw = b.password ? String(b.password) : tempPw();
      if (!okPw(pw)) return res.status(400).json({ error: 'Password needs at least 8 characters' });
      const u = { username, name: String(b.name || username).trim().slice(0, 80), role: b.role === 'admin' ? 'admin' : 'member', teamId: String(b.teamId || '').slice(0, 80), hash: hashPw(pw), mustChange: true, ver: 0, createdAt: Date.now(), createdBy: me.username };
      await putUser(u);
      return res.status(200).json({ ok: true, user: publicUser(u), tempPassword: pw });
    }
    const u = await getUser(username);
    if (!u) return res.status(404).json({ error: 'No such login' });
    if (a === 'reset'){
      const pw = b.password ? String(b.password) : tempPw();
      if (!okPw(pw)) return res.status(400).json({ error: 'Password needs at least 8 characters' });
      u.hash = hashPw(pw); u.mustChange = true; u.ver = (u.ver || 0) + 1; await putUser(u);
      return res.status(200).json({ ok: true, tempPassword: pw });
    }
    if (a === 'update'){
      if (username === me.username && (b.role === 'member' || b.disabled)) return res.status(400).json({ error: "You can't remove your own admin access" });
      if (b.name != null) u.name = String(b.name).trim().slice(0, 80) || u.name;
      if (b.role != null) u.role = b.role === 'admin' ? 'admin' : 'member';
      if (b.teamId != null) u.teamId = String(b.teamId).slice(0, 80);
      if (b.disabled != null && !!b.disabled !== !!u.disabled){ u.disabled = !!b.disabled; u.ver = (u.ver || 0) + 1; }
      await putUser(u);
      return res.status(200).json({ ok: true, user: publicUser(u) });
    }
    if (a === 'delete'){
      if (username === me.username) return res.status(400).json({ error: "You can't delete your own login" });
      await redis(['HDEL', USERS, username]);
      return res.status(200).json({ ok: true });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e){
    res.status(500).json({ error: e.message });
  }
}
