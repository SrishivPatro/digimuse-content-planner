import { redis, PREFIX, getUser, putUser, checkPw, safeEq, sessionCookie, clearCookies, ownerVer, OWNER, publicUser, normU } from './_lib.js';

// POST {username, password} signs in.  POST {logout:true} signs out.
// Username "owner" + TEAM_PASSWORD (the Vercel variable) is the admin's break-glass login.
export default async function handler(req, res){
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const body = req.body || {};
  if (body.logout){ res.setHeader('Set-Cookie', clearCookies); return res.status(200).json({ ok: true }); }
  const pw = process.env.TEAM_PASSWORD;
  if (!pw){ res.setHeader('Set-Cookie', sessionCookie('owner', ownerVer())); return res.status(200).json({ ok: true, user: OWNER }); }

  const username = normU(body.username) || 'owner';
  const password = String(body.password || '');
  const failKey = PREFIX + 'fail:' + username.slice(0, 80);
  try {
    const fails = +(await redis(['GET', failKey])) || 0;
    if (fails >= 8) return res.status(429).json({ error: 'Too many wrong attempts. Try again in 15 minutes.' });
    const fail = async () => { await redis(['INCR', failKey]); await redis(['EXPIRE', failKey, 900]); return res.status(401).json({ error: 'Wrong username or password' }); };

    if (username === 'owner'){
      if (!safeEq(password, pw)) return fail();
      res.setHeader('Set-Cookie', [sessionCookie('owner', ownerVer()), clearCookies[1]]);
      return res.status(200).json({ ok: true, user: OWNER });
    }
    const u = await getUser(username);
    if (!u || u.disabled || !checkPw(password, u.hash)) return fail();
    await redis(['DEL', failKey]);
    u.lastLogin = Date.now(); await putUser(u);
    res.setHeader('Set-Cookie', [sessionCookie(u.username, u.ver || 0), clearCookies[1]]);
    res.status(200).json({ ok: true, user: publicUser(u) });
  } catch (e){
    res.status(500).json({ error: e.message });
  }
}
