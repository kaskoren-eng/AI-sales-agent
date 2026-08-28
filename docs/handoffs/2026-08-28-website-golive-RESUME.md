# 2026-08-28 — WEBSITE FORM GO-LIVE: **DONE**

The clickscales.com demo form now creates Airtable rows and triggers calls. Verified end to end
in production: a live form submission produced board row `recVyZaT31fn0Y3xQ` in ~5 seconds.

## It was not the config flip everyone thought

Three things were wrong at once and only the first was tracked:

1. The Netlify site had no `API_BASE` / `LEAD_WEBHOOK_SECRET`, so `netlify/functions/lead.js`
   no-op'd with 204. This is the "go-live flip" in the old plan.
2. **The site has ZERO functions deployed.** `listSiteFiles` shows no function bundle at all. The
   forwarder was committed 2026-08-01 and never shipped, so setting env would have changed nothing.
3. **The form never posted to that function anyway.** `website/assets/site.js` posts urlencoded to
   `/` — Netlify Forms. Netlify had been capturing submissions all along and nothing forwarded
   them on.

## What shipped instead

Netlify Forms `submission_created` → JWS-signed webhook → `POST /webhooks/leads`, as a third
branch beside Meta and generic (`fc00b24`).

- Site hook `6a91473bcda838fe4245ff0f`, type `url`, signed with `signature_secret`.
- Railway: `NETLIFY_FORMS_WEBHOOK_SECRET` (generated, 32 random bytes; never printed or stored
  outside Railway + the Netlify hook).
- `src/modules/webhooks/netlify-forms.utils.ts` + 12 tests.

**Deliberately no site deploy.** The live HTML has drifted from git — it carries `/privacy` and
`/terms` pages that were never committed, and the served HTML is post-processed (smaller than
stored), so re-uploading either local or downloaded content would have damaged the site. The
`createSiteDeploy`-by-sha route would have preserved it, but even then the function would still
have needed a form→function bridge, so it bought nothing. **`website/netlify/functions/lead.js`
is now dead code** — it is not deployed, not reachable, and superseded. Remove it.

## Also fixed, found by the verification

`make_call` dialled an empty callee for a lead with no phone, so every email-only lead burnt three
retries into the DLQ (`missing sip callee number`). Now skips with `reason: 'no_phone'` (`2023ae2`).

## Live state

- Production `2023ae2`. Chain proven: form → Netlify Forms → signed hook → lead → Airtable row,
  and separately (2026-08-27) lead → connected outbound call.
- Netlify: 1 `url` hook + Koren's 2 existing email notifications, all on `submission_created`.
- Test artifacts cleaned: board row and Netlify submission deleted.

## Note on the 08:11 submission

`demo-en` holds a submission from 2026-08-28T08:11 UTC — name `faerw gwareg`, company `gaerh`,
phone `+972562182944`. It predates the bridge going live (08:31) so it was never forwarded. The
gibberish name/company reads like Koren's own form test rather than a real prospect, so it was
**not** replayed — replaying it would dial that number. If it was real, it can be re-sent through
`POST /webhooks/leads` with the `x-webhook-secret` header, and it will be called.

## Still open, unrelated to gate 4

1. **Layer 6 call count needs re-auditing** — production could not dial until 2026-08-27, so any
   recorded "production call" was almost certainly dialled from a dev machine.
2. `AIRTABLE_LEADS_PAT` still references `AIRTABLE_API_KEY` rather than a scoped
   `data.records:write` token.
3. Three test rows on the Airtable board (two local, one prod) to delete.
4. From the voice handoff: sweep for other "missing config → success-shaped return" spots, and
   confirm the dashboard renders the new 503 from `POST /calls/outbound` as an error.
