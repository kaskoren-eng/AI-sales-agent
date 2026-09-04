# TASK — the email channel must be connected 100% of the time, and tell us when it is not

**Raised by Koren, 2026-09-04.** Parked deliberately: "כרגע בוא נשים את זה בצד ונחזור לפיתוחים
שנעשו אתמול." **Belongs on the Airtable board** (`משימות אחרי לאנץ`, base `appLwFgbMiYseNe3p`) —
it is recorded here because the Airtable connector was down at the moment he asked, and a task
that lives only in a chat window is a task that gets lost.

## What he asked for, in his words

> "צריך לוודא שהחיבור נשאר יציב והסוכן יכול לעבוד בתוכו. הסוכן צריך להיות מחובר 100% מהזמן
> לאימייל — לשלוח ולקבל בחזרה ולקרוא אימיילים ששולחים לו. צריך לבנות לזה גם מודל שיודע להתריע
> על ניתוקים או תקלות."

Three distinct things, and only the first is partly built:

1. **Send** — works. Verified 2026-09-04: a Resend send from `koren@clickscales.com` reached
   `kaskoren@gmail.com`. `clickscales.com` IS verified in the account whose key is in `.env`.
2. **Receive and read** — the inbound webhook exists (`email.routes.ts`, svix-verified) and routes
   `email.received` into the message-processor for the tenant in `RESEND_INBOUND_TENANT_ID`. How
   much of that path has ever run on a real reply is **unverified**.
3. **Alert on disconnection or failure** — **does not exist at all.**

## What the investigation on 2026-09-04 actually found

| layer | state |
|---|---|
| `/health` | postgres + redis only. Says nothing about any integration. |
| circuit breakers (`shared/circuit-breaker.ts`) | one per integration, working. Opening the circuit writes **no log line** and notifies nobody. If DeepDub falls over, the system protects itself in silence. |
| dead-letter queue | jobs land there, `console.error` is written — **nothing drains it, nothing watches it, nobody is told.** This is the exact mechanism by which every post-call email once failed invisibly (gotcha #1, `project_production_pipeline` memory). |
| Sentry | the dependency and `plugins/sentry.ts` both exist and are wired. Active only when `SENTRY_DSN` is set. **Not set locally**; unknown in Railway. |
| Resend delivery events | `email.delivered` / `email.bounced` / `email.complained` are received and **dropped** — `email.routes.ts:52` returns 200 for anything that is not `email.received`. |
| outbound send | `email.service.ts:44` destructures only `{ error }` and discards Resend's message id, so a sent email cannot be correlated with anything that happens to it afterwards. `messages.channelMsgId` exists and is the natural home for it. |
| the RESEND API key | **restricted / send-only.** `GET /domains` and `GET /emails/{id}` both 401. A 200 from `POST /emails` proves acceptance, never delivery. |
| `RESEND_WEBHOOK_SECRET` | not set in local `.env`. |
| LiveKit cloud agent | nothing watches it. Checked by hand on 2026-09-04: Sleeping, 0 replicas, which is correct. |

**Net: today a failure is discovered when a customer mentions it.**

## Proposed shape — three layers, cheapest first

1. **A daily digest** over Resend: dead-letter depth per queue, breaker states, jobs failed in the
   last 24h. Sent **even when everything is fine**, because the absence of the mail is then itself
   the signal. This is the layer that covers "who watches the watcher": if the API is down, nothing
   can send an alert, so silence has to mean something.
2. **Immediate alerts, rate-limited**, on the failures that stop money: a breaker opening on
   LiveKit / DeepDub / Soniox / OpenAI (no call can happen), or a job reaching the dead-letter
   queue. Rate limiting is not optional — one outage must not send two hundred emails.
3. **Turn Sentry on** — a DSN in Railway. It catches the crashes and unhandled rejections that
   layers 1 and 2 structurally cannot see.

Plus the email-specific half, which is small and independent:
`sendEmail` records Resend's id into `messages.channelMsgId`; the webhook handles the delivery
events and makes a bounce or a complaint loud.

## The acceptance test, and it is the point

**An alert path nobody has deliberately broken is not an alert path.** Whatever gets built, each
connection is to be broken ON PURPOSE — a bad Resend key, a blocked LiveKit host, a poisoned job —
and the alert confirmed to have arrived in Koren's inbox. Otherwise what we have built is a feeling.

## Needs from Koren

- Add the delivery events to the Resend webhook subscription (dashboard, his Google login) and
  confirm `RESEND_WEBHOOK_SECRET` is set in Railway.
- A Sentry DSN, or a decision to skip layer 3.
- A full-access Resend key, if we want delivery status readable by API rather than by webhook.
