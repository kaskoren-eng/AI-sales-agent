# clickscales.com — marketing site

Static, dependency-free. English at `/`, Hebrew at `/he`. No build step: what is in this
folder is what gets served.

```
website/
├── index.html          English landing page (LTR)
├── he/index.html       Hebrew landing page (RTL)
├── thanks/             Post-submit page, EN (no-JS fallback target)
├── he/thanks/          Post-submit page, HE
├── assets/styles.css   One stylesheet for both languages
├── assets/site.js      Waveform, tabs, scroll reveal, form submit
├── favicon.svg
├── netlify.toml        Headers, caching, redirect
├── robots.txt
└── sitemap.xml
```

---

## Deploying

The live site is on **Netlify** (confirmed: `Server: Netlify` on clickscales.com, with
`www.clickscales.com` 301-ing to the apex). Pick whichever route you prefer.

### Option A — drag and drop (fastest)

1. Go to your Netlify site → **Deploys**.
2. Drag the **`website` folder itself** onto the "Drag and drop your site output folder here" area.
3. Done. Netlify serves `index.html` at `/` and `he/index.html` at `/he`.

Roll back any time from Deploys → pick the previous deploy → **Publish deploy**. The current
Hebrew site stays one click away, which is the safety net for the positioning change below.

### Option B — connect git (auto-deploy on push)

1. Netlify → Site configuration → **Build & deploy** → link this repository.
2. Set **Base directory** to `website`, **Publish directory** to `website`, build command empty.
3. Every push to the branch redeploys.

### Option C — CLI

```bash
npm i -g netlify-cli
netlify login          # opens your browser; nobody pastes a token anywhere
netlify deploy --dir=website            # draft URL to preview
netlify deploy --dir=website --prod     # publish
```

---

## After deploying — do these three things

1. **Check the form.** Submit the demo form once on each language. Netlify Forms captures it
   automatically from the static HTML (`data-netlify="true"`); submissions land in
   **Netlify → Forms → `demo-en` / `demo-he`**.
   > ⚠️ Set up the notification email: **Forms → Form notifications → Add notification →
   > Email notification**, to `koren@clickscales.com`. Without it, submissions sit in the
   > dashboard silently and nobody gets pinged.
2. **Resubmit the sitemap** in Google Search Console (`https://clickscales.com/sitemap.xml`) so
   the new `/he` URL and the language pairing get picked up.
3. **Watch Search Console for two weeks.** `/` changed from Hebrew to English — see the note below.

---

## The language split

**Decision (Koren, 2026-07-29): English is the primary language, Hebrew is the secondary
option.** English at `/`, Hebrew at `/he`. Both pages are complete and independent — neither
is a translation layer over the other — and `hreflang` tags on both point at each other, with
`x-default` → `/`.

Note that this supersedes `brand_assets/keren-brand-brief-v5.md` §4.4, which still says
marketing copy stays Hebrew-primary. The brief is DASHBOARD-owned territory so it is not
edited here; it needs that one line reconciled to match.

The previous site was Hebrew-only at `/`, so existing Hebrew organic traffic now lands on the
English page. Watch Search Console for a couple of weeks after the cutover. Reversing the
primary language, if it ever comes up, is a five-minute job:

1. Swap the two files: `index.html` ↔ `he/index.html` (and the same for `thanks/`).
2. In each file, update `<html lang dir>`, `<link rel="canonical">`, and the `hreflang` block.
3. Point `x-default` at whichever becomes primary.

A middle option, if you want it later: keep `/` English but add a Netlify country redirect so
Israeli visitors land on `/he` by default, with the toggle still available. Put this in
`netlify.toml` — it is deliberately **not** enabled now, because a forced redirect can hide one
language from search crawlers if misconfigured:

```toml
[[redirects]]
  from = "/"
  to = "/he"
  status = 302
  force = false
  conditions = {Country = ["IL"], Language = ["he"]}
```

---

## Optionally: send demo leads straight into Keren

Right now the form captures to Netlify Forms. Since the product is an agent that calls new
leads within 60 seconds, the obvious dogfood is to feed website leads into it directly — the
demo request triggers a real call.

That needs a server-side hop, because the lead-intake endpoint authenticates with an
`x-webhook-secret` header (`src/modules/webhooks/lead-intake.routes.ts`) which must never sit
in browser JavaScript. **The forwarder function is now written** —
`website/netlify/functions/lead.js` — but it stays **inert**: with no env vars set it no-ops
(204) and calls nobody. It's wired into `netlify.toml` (`[functions]`). Flipping it on is one
config step + one line, deliberately left to you because it makes a real phone ring.

### Go-live (3 steps — your call, triggers real calls)

1. **Netlify env vars** (Site configuration → Environment variables):
   - `API_BASE = https://ai-sales-agent-production-9736.up.railway.app`
   - `LEAD_WEBHOOK_SECRET = <the same secret set on Railway>`
2. **Railway env** — confirm the backend has both `LEAD_WEBHOOK_SECRET` (same value) and
   `LEAD_WEBHOOK_TENANT_ID = <KEREN tenant uuid>` so a `website` lead resolves to your tenant.
3. **Activate the form** — in `assets/site.js`, after the existing Netlify-Forms `fetch('/', …)`
   that captures the submission, add a fire-and-forget call so capture AND the live call both
   happen (leaving Netlify Forms as your archive):

   ```js
   // fire-and-forget: also hand the lead to KEREN so she calls within 60s
   fetch('/.netlify/functions/lead', {
     method: 'POST',
     headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
     body: data,           // the same URLSearchParams string already built above
   }).catch(function () {}); // never block the thank-you redirect on this
   ```

   Deploy. Submit the form once with **your own** number to verify the call fires, check the
   lead lands in the dashboard Calls list, then it's live.

Until step 3 ships, the function is dormant and the form behaves exactly as today
(Netlify Forms capture → `/thanks`).

---

## Local preview

```bash
python -m http.server 4321 --directory website
# English  → http://127.0.0.1:4321/
# Hebrew   → http://127.0.0.1:4321/he/
```

The form's success state will not trigger locally (`python -m http.server` rejects POST), so
it falls back to a normal navigation. That path only works on Netlify.

---

## Editing notes

- **One stylesheet, two directions.** `assets/styles.css` uses CSS logical properties
  throughout (`margin-inline-start`, `border-inline-end`, `inset-inline-end`). Never introduce
  `left`/`right` — it will break the Hebrew page.
- **Never set Hebrew in monospace.** JetBrains Mono has no Hebrew glyphs. The
  `[dir="rtl"]` block near the top of the stylesheet swaps mono for Assistant and strips
  uppercase/letter-spacing, which are meaningless in Hebrew. Both rules come from brand brief
  v5 §3.1 and §3.3.
- **Design tokens** match brand brief v5 §1 exactly, so the site and the dashboard stay one
  system. Flat cool surfaces, one indigo accent, amber only for agent-generated output, and
  **zero gradients** — that last one is what makes it read as technical rather than templated.
- **Any change means re-checking both languages.** A layout bug in Hebrew is invisible to
  someone reviewing in English.
