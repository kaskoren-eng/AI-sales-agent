/* Voice-demo token proxy.
   The browser widget (site.js, .kdemo) POSTs here to start a live call with
   Keren. Flow: verify the Turnstile CAPTCHA token, then forward to the
   ClickScales platform API, which mints a short-lived LiveKit token and
   dispatches the demo agent (30-second hard cap enforced server-side).
   Until the env vars below are set in Netlify, this returns 503 and the
   widget degrades into a "book a demo" link by design.

   Env vars (Netlify UI -> Site settings -> Environment variables):
   - VOICE_DEMO_API_URL   e.g. https://api.clickscales.com/v1/public/web-demo/session
   - VOICE_DEMO_API_KEY   shared secret; sent upstream as X-Api-Key
   - TURNSTILE_SECRET     Cloudflare Turnstile secret key. If set, a valid
                          CAPTCHA token is REQUIRED; if unset, the check is
                          skipped (dev only - set it before going live).      */
exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }
  const url = process.env.VOICE_DEMO_API_URL;
  const key = process.env.VOICE_DEMO_API_KEY;
  if (!url || !key) return json(503, { error: 'demo_not_configured' });

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch (e) { /* keep {} */ }
  const ip = event.headers['x-nf-client-connection-ip'] || '';

  const secret = process.env.TURNSTILE_SECRET;
  if (secret) {
    if (!payload.captcha) return json(403, { error: 'captcha_required' });
    try {
      const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: payload.captcha, remoteip: ip })
      }).then(r => r.json());
      if (!v.success) return json(403, { error: 'captcha_failed' });
    } catch (e) {
      return json(502, { error: 'captcha_unverifiable' });
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': key },
      body: JSON.stringify({
        lang: payload.lang === 'en' ? 'en' : 'he',
        source: 'clickscales.com',
        ip
      })
    });
    const text = await res.text();
    return { statusCode: res.status, headers: hdrs(), body: text };
  } catch (e) {
    return json(502, { error: 'upstream_unreachable' });
  }
};

function hdrs(){ return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }; }
function json(code, obj){ return { statusCode: code, headers: hdrs(), body: JSON.stringify(obj) }; }
