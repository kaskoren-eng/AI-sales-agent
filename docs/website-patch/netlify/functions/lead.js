/**
 * ClickScales — website lead → KEREN lead-intake webhook (+ Meta Conversions API).
 *
 * Why this file exists: the lead-intake endpoint authenticates with an
 * `x-webhook-secret` header (src/modules/webhooks/lead-intake.routes.ts). That
 * secret must never sit in browser JavaScript, so the browser posts here and
 * this server-side function forwards it.
 *
 * Deploy: drop at website/netlify/functions/lead.js. Netlify auto-detects it
 * and serves it at /.netlify/functions/lead — no build step, no config.
 *
 * Required Netlify environment variables (Site configuration → Environment variables):
 *   API_BASE            https://ai-sales-agent-production-9736.up.railway.app
 *   LEAD_WEBHOOK_SECRET  (same value as the API's LEAD_WEBHOOK_SECRET)
 * Optional (Meta Conversions API — server-side event, deduplicated with the pixel):
 *   META_PIXEL_ID
 *   META_CAPI_TOKEN
 */

const TIMEOUT_MS = 8000;

/** Meta requires PII hashed with SHA-256, lowercase, trimmed. */
async function hash(value) {
  if (!value) return undefined;
  const normalised = String(value).trim().toLowerCase();
  if (!normalised) return undefined;
  const bytes = new TextEncoder().encode(normalised);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** E.164-ish: strip everything but digits, prefix Israeli numbers with 972. */
function normalisePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  digits = digits.replace(/\D/g, '');
  if (digits.startsWith('0')) return '+972' + digits.slice(1);
  if (digits.startsWith('972')) return '+' + digits;
  return digits ? '+' + digits : '';
}

async function parseBody(req) {
  const type = req.headers.get('content-type') || '';
  const text = await req.text();
  if (type.includes('application/json')) {
    try { return JSON.parse(text); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function sendToKeren(lead, meta) {
  const base = process.env.API_BASE;
  const secret = process.env.LEAD_WEBHOOK_SECRET;
  if (!base || !secret) {
    console.error('lead: API_BASE or LEAD_WEBHOOK_SECRET not configured');
    return false;
  }

  const res = await fetch(`${base.replace(/\/$/, '')}/webhooks/leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-webhook-secret': secret,
      'x-lead-source': 'website',
    },
    body: JSON.stringify({
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      company: lead.company,
      source: 'clickscales.com',
      metadata: {
        language: meta.language,          // 'he' | 'en' — which page they submitted from
        page: meta.page,
        consent_source: 'website_demo_form',
        consent_given_at: meta.timestamp, // proof of consent for outbound (חוק הספאם)
        user_agent: meta.userAgent,
        ip: meta.ip,
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    console.error('lead: keren intake returned', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
}

/** Server-side Lead event. eventId matches the browser pixel's so Meta dedupes. */
async function sendToMeta(lead, meta) {
  const pixelId = process.env.META_PIXEL_ID;
  const token = process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) return; // optional — silently skip when unconfigured

  const userData = {
    em: await hash(lead.email),
    ph: await hash(lead.phone.replace(/^\+/, '')),
    fn: await hash((lead.name || '').split(' ')[0]),
    client_ip_address: meta.ip,
    client_user_agent: meta.userAgent,
  };
  if (meta.fbp) userData.fbp = meta.fbp;
  if (meta.fbc) userData.fbc = meta.fbc;

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        data: [{
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          event_id: meta.eventId,
          event_source_url: meta.page,
          action_source: 'website',
          user_data: Object.fromEntries(Object.entries(userData).filter(([, v]) => v)),
        }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) console.error('lead: meta capi returned', res.status);
  } catch (err) {
    console.error('lead: meta capi failed', err.message);
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await parseBody(req);

  // Honeypot: bots fill hidden fields. Pretend success, drop silently.
  if (body['bot-field']) return Response.json({ ok: true });

  const lead = {
    name: (body.name || '').trim(),
    email: (body.email || '').trim(),
    phone: normalisePhone(body.phone),
    company: (body.company || '').trim(),
  };

  if (!lead.phone && !lead.email) {
    return Response.json({ ok: false, error: 'phone or email required' }, { status: 400 });
  }

  const cookies = req.headers.get('cookie') || '';
  const meta = {
    language: body.language || ((req.headers.get('referer') || '').includes('/he') ? 'he' : 'en'),
    page: req.headers.get('referer') || 'https://clickscales.com/',
    timestamp: new Date().toISOString(),
    userAgent: req.headers.get('user-agent') || '',
    ip: context?.ip || req.headers.get('x-nf-client-connection-ip') || '',
    eventId: body.event_id || `lead-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    fbp: /_fbp=([^;]+)/.exec(cookies)?.[1],
    fbc: /_fbc=([^;]+)/.exec(cookies)?.[1],
  };

  // The lead reaching KEREN is what matters; Meta reporting must never block it.
  const [delivered] = await Promise.all([
    sendToKeren(lead, meta).catch((err) => {
      console.error('lead: keren intake failed', err.message);
      return false;
    }),
    sendToMeta(lead, meta),
  ]);

  // Always 200 to the browser: a lead that reached Netlify Forms is captured
  // even if the API hop failed. Failures are visible in the function logs.
  return Response.json({ ok: true, delivered });
};
