// Server-side hop: website demo form  ->  lead-intake webhook  ->  KEREN calls the lead.
//
// Why this exists: the lead-intake endpoint authenticates with an `x-webhook-secret` header
// (src/modules/webhooks/lead-intake.routes.ts). That secret must NEVER sit in browser JS, so
// the browser posts to THIS function and the function adds the secret server-side.
//
// INERT UNTIL DEPLOYED WITH ENV: if LEAD_WEBHOOK_SECRET or API_BASE is unset, it no-ops with
// 204 and never calls anyone. To go live see website/README.md "Go-live" steps.
//
// Netlify env vars required (set in Netlify → Site configuration → Environment variables):
//   API_BASE            e.g. https://ai-sales-agent-production-9736.up.railway.app
//   LEAD_WEBHOOK_SECRET must EXACTLY equal the backend's LEAD_WEBHOOK_SECRET
// Backend side (Railway) must also have LEAD_WEBHOOK_SECRET + LEAD_WEBHOOK_TENANT_ID set so
// a 'website' lead resolves to KEREN's tenant. See src/config/env.ts.
//
// Netlify Functions v2 (ESM, Request -> Response).

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const apiBase = process.env.API_BASE;
  const secret = process.env.LEAD_WEBHOOK_SECRET;

  // Parse the form body (urlencoded from the browser, or JSON if a caller sends it).
  let form = {};
  try {
    const raw = await req.text();
    const ct = req.headers.get('content-type') || '';
    form = ct.includes('application/json')
      ? JSON.parse(raw || '{}')
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // Honeypot: Netlify's bot-field is filled only by bots — drop silently.
  if (form['bot-field']) return new Response('ok');

  const name = (form.name || '').trim();
  const email = (form.email || '').trim();
  const phone = (form.phone || '').trim();

  // The webhook requires at least one contact channel.
  if (!phone && !email) {
    return new Response('phone or email required', { status: 422 });
  }

  // Not configured yet -> stay inert. The form still captured to Netlify Forms upstream.
  if (!apiBase || !secret) {
    console.log('lead fn: API_BASE/LEAD_WEBHOOK_SECRET unset — no call triggered (inert).');
    return new Response(null, { status: 204 });
  }

  try {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/webhooks/leads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-secret': secret,
        'x-lead-source': 'website',
      },
      body: JSON.stringify({
        name: name || undefined,
        email: email || undefined,
        phone: phone || undefined,
        source: 'clickscales.com',
        metadata: {
          company: (form.company || '').trim() || undefined,
          locale: form.locale || (form['form-name'] === 'demo-he' ? 'he' : 'en'),
        },
      }),
    });

    if (!res.ok) {
      // Don't leak the body to the browser; log for Netlify's function logs.
      console.error(`lead fn: webhook responded ${res.status}`);
      return new Response('upstream error', { status: 502 });
    }
  } catch (err) {
    console.error('lead fn: webhook fetch failed', err);
    return new Response('upstream unreachable', { status: 502 });
  }

  return new Response('ok');
};
