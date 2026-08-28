# 2026-08-28 — RESUME HERE: website form go-live (gate 4)

Session ended mid-task. **Nothing is half-applied** — the only step started was `netlify login`,
which was cancelled before completing. Netlify is still logged out; no site config was touched.

## Decision already made (Koren, 2026-08-28)

**Full go-live: rows AND calls.** The website form should create the Airtable row *and* let KEREN
phone the person. This supersedes the 2026-08-27 "not yet" — that hesitation was about calls, and
it was overtaken by the discovery that production could never dial at all until the trunk fix.

Why they can't be separated: `POST /webhooks/leads` both creates the lead (→ Airtable push) and
enqueues the `lead-intake` flow (→ `make_call`). Proven by test lead `d0752877`:
`flow enqueued` → `outbound call placed` → connected call. Splitting them would need either flow
surgery (which would also stop Meta leads being called) or a code change gating `make_call` on
lead source. Neither was wanted.

## Progress — steps 1-3 DONE, stopped before the redeploy

✅ 1. `netlify login` — done, authenticated as koren@clickscales.com. CLI installed globally
   (`netlify-cli/27.4.0`).
✅ 2. Site linked: **`clickscales-website`**, id `3cf92d6c-3e9d-4891-98fe-805c71188869`,
   https://clickscales.com. (`netlify link` added `.netlify` to the repo `.gitignore` — committed.)
✅ 3. Both variables set — the site previously had **none**, which is exactly why the forwarder
   had been inert:
   - `API_BASE=https://ai-sales-agent-production-9736.up.railway.app` (all contexts)
   - `LEAD_WEBHOOK_SECRET` (production context, marked `--secret`) — read straight from Railway,
     never printed. Netlify refuses `--secret` without an explicit non-dev `--context`.

⬜ 4. **REDEPLOY — the only step left, and the one that flips it live.** Netlify injects env at
   deploy time, so the function still sees nothing and still no-ops with 204. **The form is not
   live yet and no visitor can be called until this runs.**

   ⚠️ Do NOT run `netlify deploy --prod --dir=.` blindly. The site's repo is Netlify-managed
   (`hgit.services-prod.nsvcs.net/...`), so the live content may not match this worktree, and a
   content deploy from here could regress the live site. Check how the site actually builds first
   (`netlify api getSite --data '{"site_id":"3cf92d6c-3e9d-4891-98fe-805c71188869"}'`) and prefer
   triggering a rebuild of the existing source over uploading local files. `website/README.md`
   documents the site as drag-and-drop deployed, which makes this a real risk, not a theoretical
   one.

⬜ 5. Verify.

## How to verify without cold-calling a stranger

Submit the real form with a **fresh email and NO phone**. The webhook accepts email-only
(`genericLeadSchema` requires phone *or* email), so:

- a genuinely new lead is created → the Airtable push fires → row appears on the board, which is
  the thing being proven;
- with no phone there is nothing for `make_call` to dial, so nobody gets called.

Do **not** verify with Koren's own number (`+972509788845`): it already exists as lead
`d0752877`, so intake dedupes, `created` is falsy, and **no Airtable row is produced** — it looks
like a failed push when it is correct behaviour. The flow still fires, so it would call him
again for nothing.

Calling itself is already proven end-to-end (2026-08-27, room `call-out-ee6fa9df…`, both
participants ACTIVE) — it does not need re-proving here.

## State at session end

- Production: `3a5940b`, healthy, postgres + redis ok.
- `main` and all worktrees clean, nothing unpushed.
- Live and working: Airtable leads-board push (Meta Lead Ads path), outbound dialling,
  fail-loud guard on a missing SIP trunk.
- Website path: still dark — env vars staged, redeploy not run. Nothing user-visible changed.
- Netlify CLI installed globally on this machine and authenticated; `website/` is linked.

## Still open, unrelated to gate 4

1. **Layer 6 call count needs re-auditing** — production could not dial until 2026-08-27, so any
   recorded "production call" was almost certainly dialled from a dev machine.
2. `AIRTABLE_LEADS_PAT` still references `AIRTABLE_API_KEY` rather than a scoped
   `data.records:write` token.
3. Three test rows on the Airtable board (two local, one prod) to delete.
4. From the voice handoff: sweep for other "missing config → success-shaped return" spots, and
   confirm the dashboard renders the new 503 from `POST /calls/outbound` as an error.
