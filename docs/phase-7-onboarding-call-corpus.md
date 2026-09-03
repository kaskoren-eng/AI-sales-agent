# Phase 7 — Onboarding Call Corpus ("learn the client from their own calls")

> Status: **spec / not started**. Written 2026-08-30 by the architect session (Cowork).
> Implementing session: read this whole file, then read the ⚠️ TERRITORY RULES in `CLAUDE.md`
> and claim the lane below in your first commit.

---

## 1. Why this exists

`docs/gtm/client-onboarding-flow-he.md` שלב 1 is a 14-question intake form the client fills in by
hand, and the SLA explicitly does not start until it is complete. That form is the bottleneck of
every onboarding, and it is answered badly for a predictable reason: **people cannot describe how
they sell.** They write "we're friendly and professional" and then, on a real call, open with a
question about square meters, quote a price they told us never to quote, and close by offering a
site visit that is nowhere in the questionnaire.

Meanwhile most of our ICP already records their sales and service calls — Zoom, a call centre, a
mobile recorder, a CRM. That corpus is the ground truth the questionnaire is a lossy summary of.

**This feature turns "fill in the form" into "upload five real calls."** The client uploads
recordings of themselves or their team selling; we transcribe them, extract what the agent needs
to know, and present it as a reviewable draft that fills the questionnaire in for them.

Business value, in order:
1. **Onboarding time** — days 1–3 of the 5-day SLA collapse when the intake answers itself.
2. **Agent quality** — real FAQ answers in the client's own words beat invented ones.
3. **Sales asset** — "send us five calls and we'll show you what your agent will know" is a
   better demo close than a questionnaire.
4. **STT quality** — the domain vocabulary in those calls becomes Soniox bias terms, which is the
   cheapest Hebrew WER win available to us (see §7.3).

---

## 2. What it is, in one paragraph

A tenant-scoped ingestion pipeline: the client uploads audio → it lands in object storage with a
retention clock → a worker transcribes it (Hebrew-first) → a second, corpus-level worker reads
**all** the tenant's transcripts together and emits discrete, evidence-backed **insight items**
(FAQ answers, objections + rebuttals, qualification criteria, disqualifiers, domain glossary,
call-shape observations) → the dashboard shows each item next to the quote it came from → a human
approves or rejects **item by item** → approved items are written through the *existing* typed
settings routes into `agent_persona` / `businessProfile`. The audio is deleted after N days; the
transcripts and insights survive.

---

## 3. Non-goals (say no to these explicitly)

- **No fine-tuning and no voice cloning.** We do not train a model on client audio and we do not
  build a TTS voice from a recorded human. Both are legal landmines and neither is needed.
- **No automatic prompt rewriting.** Nothing this pipeline produces edits
  `prompts/system-prompt.he.ts`. The Hebrew in that file was tuned by ear over months of real
  calls — see the header comment in `persona.ts`. Extraction writes to *settings*, never to prompt
  source.
- **No writes to the `tts` half of `agent_persona`.** That half is operator-only for a reason: a
  wrong `voiceId` produces a silent stream, not an error. `PUT /settings/agent-persona` is
  `.strict()` and has no `tts` field — apply through that route and the property holds for free.
- **Not a call-analytics product.** `call_learnings` already analyses *our agent's* calls. This
  analyses *the client's human* calls, once, at onboarding. Different table, different lifecycle,
  do not merge them.
- **Not a replacement for the questionnaire.** It pre-fills it. Ops still confirms.

---

## 4. Territory, branch, claims

| Item | Value |
|---|---|
| Lane | **New de-facto territory: ONBOARDING** — same rule as WEBSITE/INTEGRATIONS: whoever picks it up records it in `CLAUDE.md`. Add `src/modules/onboarding/**` to `CODEOWNERS` + `scripts/ci/territory-check.sh` in the same commit. |
| Branch | `feature/onboarding-corpus-*` |
| Migration claim | **0018** — `onboarding_samples` + `onboarding_insights`. `main` says "next free: 0018". Verify against `origin/main` before generating; if another session took it, take the next and update the claims line. |
| New `tenants.settings` key | **none.** Deliberate — outputs land in the already-claimed `agent_persona` (VOICE) and `businessProfile` (shared). If you find you need one, stop and ask: it is a sign the extraction is writing something the agent does not actually read. |
| Cross-lane touch | Writing to `agent_persona` is VOICE-owned data. You are *calling the existing typed route*, not editing VOICE files — that is allowed. If you find yourself editing anything under `channels/voice-livekit/**` beyond the bias-terms hook in §7.3, stop and tell Koren. |
| Shared files | `src/config/env.ts`, `.env.example`, `package.json`, `server.ts` — additive only, rebase before touching. |

⚠️ At the time of writing, `main` has an uncommitted local change to
`src/modules/channels/voice-livekit/prompts/system-prompt.he.ts`. That is another session's work —
do not revert, stash, or commit it.

---

## 5. Data model (migration 0018)

Two tables. Both `tenant_id uuid not null references tenants(id) on delete cascade` — the FK is not
optional here; `call_learnings` shipped without one (fixed late in 0010) and left orphaned voice
data behind, which is exactly the failure mode the privacy policy has opinions about.

### 5.1 `onboarding_samples` — one row per uploaded recording

```
id                uuid pk
tenant_id         uuid not null -> tenants (cascade)
uploaded_by       uuid null -> users (set null)
original_filename varchar(255)
mime_type         varchar(64)
size_bytes        integer
duration_secs     integer null          -- filled after probe
language          varchar(8) default 'he'
speaker_map       jsonb default '{}'    -- { "spk_0": "agent" | "customer" } — see §7.2
storage_key       varchar(512) null     -- null once purged
storage_expires_at timestamp null       -- retention clock
consent_confirmed_at timestamp not null -- upload is refused without it (§9)
status            varchar(20) not null default 'pending'
                  -- pending -> uploaded -> transcribing -> transcribed | failed
transcript        jsonb default '[]'    -- reuse TranscriptSegment[] from call-learnings.ts
error             text null
created_at        timestamp not null default now()
purged_at         timestamp null
```
Index: `(tenant_id, created_at)`. Do not repeat the `call_learnings` mistake of shipping with only
a PK.

### 5.2 `onboarding_insights` — one row per extracted item (this is what makes review possible)

```
id           uuid pk
tenant_id    uuid not null -> tenants (cascade)
kind         varchar(32) not null
             -- faq | objection | business_fact | qualifier | disqualifier
             -- | glossary_term | style_note | call_shape
payload      jsonb not null   -- shape depends on kind, see §7.1
evidence     jsonb not null   -- [{ sampleId, quote, atMs }] — at least one, always
confidence   integer          -- 0-100, the model's own, shown but never trusted
target       varchar(64) null -- 'agent_persona.faq' | 'businessProfile.qualifiers' | ...
status       varchar(16) not null default 'proposed'
             -- proposed -> approved -> applied | rejected
reviewed_by  uuid null -> users
applied_at   timestamp null
created_at   timestamp not null default now()
```

**`evidence` is not optional and not decoration.** An insight with no quote is a hallucination with
a confidence score. The review UI shows the quote first and the claim second; a reviewer who cannot
see where a "fact" came from will approve it.

Run `npm run db:drift` after generating. Schema drift is invisible to both the tests and
`db:generate` — that is how two `scheduled_calls` columns disagreed with production since 0000.

---

## 6. Pipeline

```
dashboard                 API                     storage        queues
────────────────────────────────────────────────────────────────────────────────
[consent checkbox]
[drag files]  ──POST /onboarding/samples──▶ row(status=pending)
              ◀── { sampleId, presignedPutUrl }
   PUT file ─────────────────────────────────────▶ R2/S3
              ──POST /:id/complete──────▶ status=uploaded ──▶ onboarding-ingest
                                                             │
                                            ffprobe duration │
                                            transcribe (§7.0)│
                                            status=transcribed
                                                             │
              ──POST /onboarding/extract─────────────────▶ onboarding-extract
                                                             │ reads ALL transcribed
                                                             │ samples for the tenant
                                                             ▼
                                              N × onboarding_insights (status=proposed)
[review list] ──PATCH /insights/:id {approve|reject}
[Apply]       ──POST /onboarding/apply────▶ PUT /settings/agent-persona
                                            PATCH businessProfile
                                            status=applied, audit_events row
```

Two queues, not one: transcription is per-file and parallel; extraction is per-corpus and must see
every transcript at once — objections and FAQ only become visible as **repetition across calls**.
One call is an anecdote. Refuse corpus extraction below **3 transcribed samples** and say so in the
UI; that threshold is the single biggest quality lever in this feature.

Both workers move exhausted jobs to `dead-letter`, like the other six.

---

## 7. Extraction

### 7.0 Transcription

**Hebrew → Soniox. Not Whisper.** Whisper's Hebrew is what
`CallAnalysisService.downloadAndTranscribe` uses today and it is the weaker arm of a benchmark we
already ran (see `CLAUDE.md`, and `stt/wer.ts`). Use Soniox's **async/batch file endpoint** with
speaker diarization; `transcribeBuffer` in `stt/soniox.stt.ts` is a realtime-stream harness for
benchmarking and is the wrong tool for a 40-minute uploaded file — but reuse `sonioxCircuit` so an
outage cannot hammer them. Whisper stays as the fallback for non-Hebrew uploads only.

Decode/probe with `ffmpeg`/`ffprobe` (add to `Dockerfile` if absent — announce the dep).

### 7.1 What to extract, and where each kind lands

| kind | payload | target | notes |
|---|---|---|---|
| `faq` | `{ topic, answer }` | `agent_persona.faq[]` | Exactly the existing `PersonaFaqEntry`. **Answer must be the client's own words**, lightly cleaned — that is the whole point. |
| `objection` | `{ objection, response }` | the prompt's `objectionPlaybook` slot | Find where `slots.objectionPlaybook` is sourced today and write to *that* key. Do not invent a new one. |
| `qualifier` / `disqualifier` | `{ text }` | `businessProfile` | Maps to questionnaire Q3/Q4. |
| `business_fact` | `{ label, value }` | `businessProfile` | Hours, service area, lead times, what they do/don't sell. |
| `glossary_term` | `{ term, latin?, note? }` | STT bias terms (§7.3) | Product names, neighbourhoods, brand names, industry jargon. |
| `style_note` | `{ observation }` | **report only — never auto-applied** | "Opens with a question, not a pitch." "Never quotes price before a site visit." Ops reads these and decides. |
| `call_shape` | `{ medianDurationSec, typicalOpening, questionOrder[], typicalClose }` | **report only** | The "what does a real call in this business look like" deliverable. |

Model: `AI_MODEL` (gpt-5.4), `response_format: json_object`, same pattern as
`CallAnalysisService.analyzeTranscript`. Prompt the model to **quote before it claims** — emit the
evidence quote for each item as part of the same JSON object, not as a second pass.

### 7.2 Who is the salesperson? (the trap that will bite you)

Diarization gives you `spk_0` / `spk_1`, not roles, and Hebrew diarization is the weakest part of
the stack. Extracting "the client's FAQ answers" from the *customer's* turns produces confident
nonsense.

Do both: (a) a heuristic first pass — the party who asks more questions, speaks more total seconds,
and says the company name is probably the salesperson; (b) **show the user a two-line sample of each
speaker and make them confirm**, stored in `speaker_map`. Do not extract until the map is set. This
is a 20-line UI that prevents the single most likely quality failure.

### 7.3 Glossary → Soniox bias terms (the sleeper win)

`parseBiasTerms(prompt)` already exists in `stt/soniox.stt.ts` — the agent biases its STT toward
terms found in its own prompt. Approved `glossary_term` insights should reach that path, so a
client's product names and neighbourhood names are recognised on **live** calls. Wire this by
getting the terms into the text `parseBiasTerms` already reads, not by adding a new mechanism.
This is the one place the feature touches VOICE files — keep it to that, and announce it.

---

## 8. API surface (`src/modules/onboarding/`, mounted under `/api/v1/onboarding`)

```
POST   /samples                 -> { sampleId, uploadUrl }   (consent required)
POST   /samples/:id/complete    -> enqueue ingest
GET    /samples                 -> list + status + duration
PATCH  /samples/:id/speakers    -> speaker_map
DELETE /samples/:id             -> purge audio + row, audited
GET    /samples/:id/transcript
POST   /extract                 -> enqueue corpus extraction (409 if < 3 transcribed)
GET    /insights?status=        -> grouped by kind, with evidence
PATCH  /insights/:id            -> { status: approved | rejected }
POST   /apply                   -> write all approved -> settings; audit_events; status=applied
GET    /report                  -> the human-readable brief (style notes + call shape + coverage)
```

Tenant-scoped, dual auth, every route filters by `tenant_id`. `POST /apply` writes an
`audit_events` row naming every insight applied — this changes what leads hear, so it must be
reconstructable six months later.

**Upload: presigned PUT, not multipart through Fastify.** `@fastify/multipart` is not installed and
pushing 200MB audio through the API container to re-upload it is pure waste. Presigned URLs cost one
SDK dep and keep the API stateless.

---

## 9. Storage, retention, consent

- **Store:** S3-compatible object storage (Cloudflare R2 recommended — no egress fees, S3 SDK
  compatible). New env block: `ONBOARDING_STORAGE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY_ID`,
  `_SECRET_ACCESS_KEY`, `ONBOARDING_AUDIO_RETENTION_DAYS` (default **30**). Zod-validated in
  `src/config/env.ts` + `.env.example`, **optional** — unset means the feature 503s, like
  `ADMIN_API_KEY`. Do not make an unconfigured optional vendor break boot.
- **Retention:** `storage_expires_at = uploaded_at + RETENTION_DAYS`. A repeatable BullMQ job purges
  expired objects daily and sets `storage_key = null, purged_at = now()`. Transcripts and insights
  survive the purge — that is the point of the split.
- **Tenant deletion** must purge the bucket, not just cascade the rows. A DB cascade that leaves
  audio in a bucket is the same orphan problem in a more expensive place.
- **Consent gate:** upload is refused without an explicit, logged confirmation that the tenant has
  the right to share these recordings and that the recorded parties were notified. Store
  `consent_confirmed_at` + an `audit_events` row. Wording comes from `docs/legal-drafts/` — ask
  Koren before inventing it, and get it into the DPA.
- **PII:** these are real customers' voices and phone numbers. Never log transcript content. Never
  send it anywhere but OpenAI for extraction. It is not `call_learnings` — do not let it leak into
  the calls list, the Copilot, or any metrics rollup.

---

## 10. Billing

Transcription is a real per-minute cost with no revenue attached. Record it, do not charge it:
a `usage_events` row of a new kind (`onboarding_transcription`) at **zero billable units**, with
minutes, mirroring exactly how calls are recorded as a cost signal (`billing/pricing.ts`). Same
idempotency contract: the `(tenant_id, kind, dedupe_key)` unique index, `dedupe_key = sampleId`.
Never throw from the meter.

Cap it: **10 files, 200 MB each, 2 hours total audio** per tenant, enforced server-side. Without a
cap, one client's 40-hour call archive is an unbudgeted invoice.

---

## 11. Phasing — ship P0 alone if you have to

| Phase | Scope | Done when |
|---|---|---|
| **P0 — ingest** | migration 0018, storage + presigned upload, consent gate, transcription worker, speaker map, transcript viewer, retention purge | A client uploads 5 calls and ops can read accurate Hebrew transcripts in the dashboard. **This is already worth shipping** — transcripts alone beat the questionnaire. |
| **P1 — extract & review** | corpus worker, `onboarding_insights` + evidence, review UI, `POST /apply` → `agent_persona.faq` + `businessProfile` | Ops approves ~15 items from a real corpus and a live call quotes an approved FAQ answer. |
| **P2 — depth** | glossary → bias terms, objection playbook, the `/report` brief | A domain term the STT used to mangle is transcribed correctly on a live call. |
| **P3 — later** | re-extraction on a newer model, auto-fill of the שלב 1 questionnaire, client-facing self-serve upload link | — |

**Definition of done, every phase:** `npm test` green · `npm run db:drift` clean · reviewed in
Hebrew *and* English (`dir` correct, no hardcoded strings — brief v5 §4) · `agent_persona`
`DEFAULT_PERSONA` byte-equality test still passing · handoff written to
`docs/handoffs/YYYY-MM-DD-onboarding.md`.

---

## 12. Known traps

1. **One call is an anecdote.** Hard-refuse extraction below 3 samples.
2. **Diarization roles** — §7.2. Confirm with the human.
3. **A confident wrong FAQ is worse than no FAQ.** Evidence quote or the item does not exist.
4. **Do not touch `tts`.** Apply only through the `.strict()` persona route.
5. **Do not collapse the two language settings.** Agent spoken language (VOICE) and dashboard
   interface language (DASHBOARD) stay separate. Sample `language` is a third, per-file thing —
   derive nothing from it.
6. **`call_learnings` is not this table.** Different lifecycle, different consent basis, different
   retention. Resist the merge.
7. **The prompt is not a dumping ground.** Every applied insight grows the system prompt, which
   costs latency on every turn and dilutes instruction-following. Cap what lands: FAQ ≤ ~12 entries,
   objections ≤ ~6. If ops wants more, that is a retrieval problem, not a prompt problem.
8. **Schedule.** This is not a launch gate. The gates are Layer 6 of
   `docs/phase-6-verification-checklist.md` (10 real calls), Workstream B and C live verification,
   and the website flip. If picking this up would delay those, say so to Koren before starting.

---

## 13. Open decisions for Koren

1. **R2 vs S3 vs Backblaze** — needs an account either way. R2 recommended (no egress).
2. **Who uploads?** Client self-serve in their dashboard, or ops uploads on their behalf from the
   operator console during onboarding? P0 is simpler if it is ops-only; the sales pitch is stronger
   if it is self-serve. Recommendation: build the API tenant-scoped, expose it in the tenant
   dashboard, and let ops use it while impersonating during onboarding.
3. **Consent wording + DPA amendment** — legal, not engineering. Blocks P0 shipping to a real
   client, not P0 being built.
4. **Retention: 30 days?** Long enough to re-extract during onboarding, short enough to defend.
5. **Does this run before or after the launch gates?** See trap 8.
