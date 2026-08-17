# 2026-08-17 — usage metering, the AI disclosure, and deletion

Workstream: VOICE + backend. Branch: `main`. Three commits, all pushed, 850 tests green.

| commit | what |
|---|---|
| `1e073b6` | Phase 5a — usage metering write path (migration 0013) |
| `9cefcb5` | AI disclosure moved into the spoken greeting |
| `5dd684d` | `DELETE /leads/:id` and `DELETE /calls/:id` |

---

## 1. Metering — because usage cannot be backfilled from nothing

Phase 5a of the plan, and the last item on the customer-#2 gate that needed nothing from you.
It ships **before** the thing that reads it for one reason: a quota screen built next month reads
a month of history, whereas a meter built next month reads an empty table. The first invoice
dispute is unwinnable without a ledger.

### Two questions people conflate, so they got separate columns

- **Billable units are LEADS.** ₪1,490/150 and ₪2,490/400 with per-lead overage, per
  `docs/gtm/pricing-model.md`. This is what appears on an invoice.
- **Measured cost is tokens, minutes and characters.** It never appears on an invoice. It is the
  margin signal — and the only way that doc's bolded "real cost/minute has never been measured" ⚠️
  ever gets closed.

### The design decisions worth knowing

- **The ledger is the truth; `usage_periods` is a cache of it.** Any disagreement is resolved by
  recomputing the counter from the ledger, never the reverse. That direction is recoverable; the
  other lets a drifted counter bill units with no evidence behind them.
- **Idempotency is a unique index**, `(tenant_id, kind, dedupe_key)` — not application logic. A
  retried BullMQ job, a double-delivered webhook and a worker SIGKILLed mid-write all converge on
  one row. The event insert and the counter increment share a transaction, and the increment only
  runs when the insert actually inserted.
- **`meterLead` / `meterCall` never throw.** A counter must not be able to fail a customer's lead
  intake or an agent's call teardown. That is only defensible because both units are REBUILDABLE —
  a lead is a row in `leads`, a call's cost is in `call_learnings.call_report->usage` — so
  `npm run usage:reconcile` closes any gap. Without reconciliation, "never throws" would just mean
  "silently under-bills".
- **Money is integers.** Prices in agorot, cost in **milli-agorot**. A 30-second call is a fraction
  of an agora; rounding per call to the nearest agora would floor most calls to zero and report the
  month as free.
- **Periods are anchor-day midnights in Asia/Jerusalem**, not UTC. Israel is +2/+3, so a lead at
  00:30 on the 1st would land in the previous month under UTC — a small error that is impossible to
  explain on a phone call. Anchor day is constrained 1..28 so the maths has no February edge case.
- **Billing fields are real columns, not `settings` keys.** Read on the hot path, queried across
  tenants (`WHERE billing_status='past_due'`), FK-constrained, and unwritable through
  `PATCH /tenants/me` **by construction** rather than by a validator someone later loosens.

### The nine call sites, and the tenth

There are nine `insert(leads)` sites: API, website intake, Meta Lead Ads, WhatsApp, email, CSV,
Google Sheets, Monday, and the voice agent. There will be a tenth, and the failure mode is the
worst kind — **silent under-billing**. Nothing errors, no alert fires, nobody reports being
under-charged, and it can run for months.

`metering-coverage.test.ts` fails when a new site appears that neither meters nor carries a
`usage-metering: exempt` marker. (I broke a call site on purpose to confirm the guard actually
fires and names the file and line — a guard that has never failed is not a guard.)

A database trigger would catch all ten by construction and was the first design. Rejected for two
reasons: this suite has no Postgres, so a trigger would be **untested code on the money path**; and
one of the nine inserts the "Web simulator" placeholder lead, which a blanket trigger would bill
customers for. Charging someone for opening the simulator to test their own agent is the kind of
line item that ends a trial.

**Two sites are exempt, and both are judgement calls you can overrule in one line:**

1. The **Web simulator placeholder** — plumbing, not a lead.
2. **Opt-out suppression records** (`end-call.tool.ts`) — someone who says "take me off your list"
   creates a do-not-contact row. I decided that is not a billable lead. If you disagree, it is one
   `meterLead` call.

---

## 2. The AI disclosure — a control that measured its own 100% failure

`docs/risk/measured-findings-from-call-reports.md` measured the disclosure as **not spoken on 10 of
10 real calls**. Everything needed to say it already existed — a detector, a report field, an
end-of-call instruction — and the instrumentation faithfully recorded that it never happened.

The reason is the whole lesson: the disclosure was a **request to the model** ("include this in your
goodbye"). When no caller asked and no goodbye ran, nothing said it. Your own risk doc reached the
same conclusion and recommended the same fix: *a fixed opening beats a prompt instruction, because a
model can skip an instruction and a recording cannot.*

So it moved into the greeting, which `agent.ts` speaks verbatim via `session.say()`:

```
was:  שלום, מדברת קרן מ-ClickScales. איך אני יכולה לעזור?
now:  שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?
```

Four extra syllables, same rhythm, and the phrase was already in the detector's pattern list — so
`ai_disclosure` should now read `during_call` on every call with no detector change.

This also moves us from end-of-call disclosure to **early** disclosure, which is what the EU AI Act
(Art. 50) and California SB 1001 require. Israel has no statute yet, so the old behaviour was
defensible; the real exposure was the gap between the website's Voice-AI disclosure page — which
promises Keren introduces herself as an AI — and the measurement saying she does not.

A tenant's own greeting is kept **exactly as written** when it already discloses, and gets one
appended sentence when it does not. The append is deliberately visible, and the dashboard preview
renders the same string the agent speaks, so a tenant who dislikes the seam can fold the disclosure
into their own wording and it disappears. It is idempotent — it never stacks.

Masculine patterns were added to the detector too. Agent gender is a tenant setting, and without
them a male agent could disclose perfectly and still be reported `missed` — a compliance report
wrong in the direction of alarm, which is how a real finding later gets waved away as a known false
positive.

> ⚠️ **This changes the first sentence every lead hears.** The golden-fixture test caught it, which
> is exactly what it is for; I updated it deliberately and recorded the before/after in the test.
> The system prompt itself is still pinned byte-for-byte — this one line is all that moved.
> **Worth one listen before `npm run agent:deploy`.**

---

## 3. Deletion — the privacy policy promised it; nothing implemented it

`docs/legal-drafts/` commits to deleting personal data on request. The only honest answer was a
hand-written SQL statement, and the only record that it happened was somebody remembering.

`DELETE /api/v1/leads/:id` and `DELETE /api/v1/calls/:id`, both writing an `audit_events` row
carrying counts and (for a lead) the name captured before deletion — never a phone, an email or a
transcript. An audit trail that accumulates the data it just erased is simply a second copy of it.

Hand-rolled rather than `ON DELETE CASCADE`: no child FK cascades today, so a bare DELETE fails on a
foreign key and nothing is erased. Adding cascades would be tidier and much more dangerous —
cascade is invisible at the call site, so any future code path that deletes a lead would silently
destroy its conversations too.

**Three boundaries, each visible in the response rather than buried:**

| what | why |
|---|---|
| the **usage ledger survives** a lead deletion | it holds a count and an id, never a name or a transcript — and erasing it would let anyone delete their way out of an invoice |
| **calendar events are not cancelled** (`calendarEventsNotCancelled`) | deleting a row must not silently cancel a real meeting in a customer's diary |
| **recordings are not deleted** (`recordingsNotDeleted`) | the audio lives with the provider; `deleted: true` must not imply an erasure that did not happen |

Reminders **are** cancelled — those are ours and internal, and one firing about a deleted lead would
send their name onward after erasure. Deleting a call leaves the lead alone: erasing one recording
is not a request to be forgotten entirely.

---

## 🔴 For Koren

1. **Listen to the new greeting** before the next `agent:deploy`. It is the first thing every lead
   hears. One line to revert if you dislike it (`DEFAULT_PERSONA.greeting`).
2. **`npm run db:migrate`** — 0011, 0012 and 0013 are all pending. Then
   `node scripts/provision-number.mjs --number +972555070922 --tenant 613d826c-…` **before**
   `npm run agent:deploy`, or the live inbound line goes dead.
3. **Assign a plan to every tenant.** ClickScales should be on the seeded `internal` plan —
   otherwise it sits on the `trialing` default with no included leads, and the first thing Phase 5b's
   hard enforcement would do is throttle the live production tenant:
   ```sql
   UPDATE tenants SET plan_code='internal', billing_status='active' WHERE id='613d826c-…';
   ```
4. **The OAuth client + `PLATFORM_TENANT_ID`** — still the one that can break the live customer's
   calendar. Unchanged from yesterday's handoff.

## Questions for the architect

- **`RATE_CARD` in `pricing.ts` is unverified list prices.** The shape is right and every event
  stores a `rateVersion`, so a correction can re-price history rather than invalidate it — but the
  numbers need one real provider invoice before any margin figure is quoted to anyone. A sanity
  test asserts the estimate stays within an order of magnitude of the doc's $0.12/min ceiling; that
  is a smoke alarm, not a measurement.
- **Do opt-out suppression records bill?** I said no. Reversible in one line.
- **Who is alerted when a live tenant's calendar is revoked?** Still open from yesterday — the
  `sendAlert` machinery in `spend-guard.ts` is the model. Operator, customer, or both.
- ~~Nothing has run against a real database yet.~~ **Verified against real Postgres 17.** I built a
  throwaway database (`migration_check`) on the local docker instance — the dev database was not
  touched — applied all 14 migrations from scratch, and ran the real metering path against it:

  | check | result |
  |---|---|
  | all migrations apply from an empty database | ✅ |
  | plans seeded: base / growth / custom / internal | ✅ |
  | a repeated lead and a repeated call are rejected by the unique index | ✅ 3 rows, not 5 |
  | `leads_used` and `measured_cost` equal the ledger | ✅ |
  | plan snapshot frozen into the period (`base`, 150 included) | ✅ |
  | period boundary for anchor day 12 | `2026-08-11 21:00Z` = **2026-08-12 00:00 Israel** ✅ |

  The one number worth your eye: a 1-minute call priced out at **₪0.2368 ≈ $0.064/min**, against
  `pricing-model.md`'s conservative $0.12/min ceiling and its $0.08 target. That is an estimate
  built on unverified list prices, not a measurement — but it is the right order of magnitude,
  which is the first time that has been checkable at all.

  Still untested against a real database: the two DELETE endpoints (mocks only), and the OAuth
  calendar path (unchanged from yesterday — no client exists yet).
