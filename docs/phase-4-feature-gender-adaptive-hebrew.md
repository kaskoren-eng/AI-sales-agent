# Phase 4 Feature: Gender-Adaptive Hebrew Grammar

**Priority:** Medium — significant UX improvement
**Complexity:** Medium — new gender detection service + prompt engineering + logging
**Depends on:** Keren system prompt v2 (already deployed), Soniox STT (for reliable transcripts)

---

## Copy-Paste Prompt for Claude Code

```
TASK: Build gender-adaptive Hebrew grammar for the voice agent (Keren).

CONTEXT:
Hebrew is a heavily gendered language. Every verb, adjective, and possessive 
addressing the listener changes based on the listener's gender (masculine vs feminine). 
Currently Keren defaults to masculine forms when addressing leads ("אתה מוכר", 
"בוא נקבע", "תראה", "תקבל") — this feels off when the lead is female. We want 
Keren to detect the lead's gender and adapt her Hebrew accordingly.

Current system prompt lives at src/modules/channels/voice-livekit/prompts/system-prompt.he.ts 
(the Keren v2 version with the "Gender note" section).

DELIVERABLES:

1. LEAD GENDER DETECTION SERVICE
   Create src/modules/channels/voice-livekit/gender/lead-gender.service.ts with:
   
   a. Name-based detection (fastest path):
      - Input: lead's first name (from lead context, e.g. "יובל", "שרה", "רוני")
      - Use a Hebrew name → gender lookup. Approach options:
        * Static JSON dictionary of common Israeli names (500-1000 entries covering 
          ~90% of Hebrew names). Source suggestion: search HuggingFace / GitHub for 
          "hebrew first names gender" datasets, or scrape from Israeli CBS 
          (Central Bureau of Statistics) baby name reports.
        * For gender-ambiguous names (רוני, אריאל, נועם, שי, יעל, etc.) — mark as 
          "unknown", fall through to LLM inference.
      - Return: { gender: 'male' | 'female' | 'unknown', confidence: 0-1, source: 'name' }
   
   b. LLM-based inference (fallback + confirmation):
      - Input: first 2-3 turns of the transcript
      - Prompt a small/fast LLM (gpt-5-nano is fine here — accuracy > latency for this) 
        to classify: "Based on this Hebrew transcript, what is the speaker's gender? 
        Look for self-references (אני עסוק/עסוקה, אני רוצה — same for both, but 
        אני שמח/שמחה differs), family references (הבעל שלי → female, האישה שלי → 
        male), etc. Return only: male | female | unknown"
      - Run this ASYNCHRONOUSLY after turn 2 — do NOT block the main call flow
      - When result arrives, update the dynamic variable for subsequent turns
      - Return: { gender, confidence, source: 'llm_inference', reasoning: '...' }
   
   c. Combined resolver:
      - If name-based gives 'male' or 'female' with confidence > 0.85 → use that
      - Otherwise → default to 'unknown' initially, kick off LLM inference in 
        background, update mid-call when result returns
      - If still 'unknown' after 3 turns → default to masculine (safe fallback)

2. DYNAMIC VARIABLE INJECTION
   Add lead_gender to the dynamic variables passed to the system prompt at call start.
   
   Format in prompt: inject a new instruction block:
   
   ```
   LEAD GENDER: {{lead_gender}}
   
   Adapt all Hebrew addressing the lead based on this:
   - If male: "אתה מוכר", "בוא נקבע", "תראה", "תקבל אישור", "מה נוח לך"
   - If female: "את מוכרת", "בואי נקבע", "תראי", "תקבלי אישור", "מה נוח לך" 
     (note: לך is same for both)
   - If unknown: default to masculine forms (Hebrew business default)
   ```
   
   Place this block AFTER the "Gender note" section (which is about Keren herself), 
   BEFORE the "Call Flow Overview" section.

3. MID-CALL UPDATE MECHANISM
   If the name-based detection returned 'unknown' but the LLM inference later 
   determines the gender, the system prompt needs to be updated mid-call. 
   
   Options (pick whichever LiveKit Agents SDK best supports):
   a. Session.updateInstructions() if it exists
   b. Insert a system message at the point of detection: 
      "SYSTEM UPDATE: Lead gender detected as female. Switch all lead-facing Hebrew 
      to feminine forms starting now."
   c. Full session restart with new instructions (heaviest, avoid if possible)

4. LOGGING & OBSERVABILITY
   Every call must log to call_learnings (extend the jsonb 'analysis' field):
   - detected_lead_gender: 'male' | 'female' | 'unknown'
   - detection_source: 'name' | 'llm_inference' | 'default'
   - detection_confidence: 0-1
   - detection_turn: which turn (1, 2, 3...) the gender was locked in
   - manual_override: null (reserved for future — human can correct in dashboard)
   
   This lets us measure detection accuracy over the first 100 real calls and 
   tune the name dictionary.

5. UPDATE THE KEREN SYSTEM PROMPT
   In src/modules/channels/voice-livekit/prompts/system-prompt.he.ts:
   
   a. Remove any hardcoded masculine addressing (like "אתה מוכר", "בוא נקבע") 
      from the example scripts in Step 2 and Step 4. Replace with placeholders 
      like {{gender_verb_addressing_you}}.
   
   b. OR — simpler approach — add explicit gender-conditional versions of each 
      quoted phrase, like:
      
      Step 4 booking offer:
      > "נשמע שממש מתאים למה שאנחנו עושים. בוא/בואי נקבע שיחת דמו קצרה של 30 
        דקות שבה תראה/תראי איך זה עובד בפועל - מתי נוח לך?"
      
      Then instruct the LLM in the prompt: "Choose the form matching LEAD GENDER 
      above. Only speak one form, never both."

6. TESTS
   Create tests/lead-gender-detection.test.ts with:
   - 20 name samples testing accuracy:
     * Clearly male: יובל, דוד, אמיר, יוסי, אבי, רון
     * Clearly female: שרה, מיכל, נועה, טליה, קרן, יעל (careful — יעל can be both)
     * Ambiguous: רוני, אריאל, נועם, שי, גל, אור
   - Assert that clearly male/female names return correct gender with high confidence
   - Assert that ambiguous names return 'unknown' (so we fall through to LLM)
   - Mock LLM responses for the inference path — assert it uses them correctly

CONSTRAINTS:
- Do NOT introduce a race condition where the LLM inference arrives mid-turn 
  and confuses Keren mid-sentence. Update AFTER a full turn boundary.
- Do NOT add >100ms of latency to the first turn. Name lookup should be synchronous 
  and fast (<5ms); LLM inference must be background.
- Circuit breaker on the LLM inference call (using the existing pattern in 
  src/shared/circuit-breaker.ts).
- If the whole gender detection pipeline fails for any reason, silently fall back 
  to masculine (current behavior). Never let this feature block a call.
- Follow all existing project conventions (imports with .js, Zod env vars if needed, 
  AppError subclasses, tenant isolation on call_learnings updates).
- Feature flag: add GENDER_ADAPTIVE_ENABLED env var (default false). Enable per 
  tenant via tenants.settings.

DELIVERABLE FORMAT:
Commit each piece separately on branch feature/gender-adaptive-hebrew:
1. Gender detection service + name dictionary + tests
2. Dynamic variable wiring into system prompt
3. Mid-call update mechanism
4. Logging to call_learnings + migration if needed
5. Prompt update to Keren system prompt
6. E2E test with one female-named lead and one male-named lead

REPORT WHEN DONE:
- The 20 test cases: which passed / failed / had unexpected behavior
- Estimated LLM inference cost per call (should be <$0.001)
- Sample transcripts showing Keren correctly using feminine forms with a female lead
- Any Hebrew grammar edge cases you discovered (e.g. plural forms, formal register)
- Recommendation on when to switch GENDER_ADAPTIVE_ENABLED from false to true for 
  Koren's tenant

Explain terminology as you go — I'm not a developer. Hebrew grammar rules should be 
called out clearly so I can validate them.
```

---

## Why This Matters (business justification for prioritization)

Hebrew speakers are highly attuned to gender mismatches — hearing "אתה מוכר" when 
you're female sounds jarring and unprofessional in a way English speakers won't 
appreciate. For a sales agent whose job is to build trust in the first 30 seconds, 
this is a subtle but real quality signal.

**Expected impact:** noticeable UX improvement on ~50% of calls (female-named leads). 
Not measurable in latency or conversion in the first weeks, but likely reduces 
"this agent isn't paying attention to me" objections.

**Timing:** Build this in Phase 4 alongside the booking flow. Don't rush it into 
Phase 3 (SIP integration) — get the phone calls working first, then polish the voice.

---

## Related Files

- Current system prompt: `src/modules/channels/voice-livekit/prompts/system-prompt.he.ts`
- Reference (v2 prompt): `docs/archive/system-prompt-keren-v2.md`
- Development methodology: `docs/voice-agent-development-methodology.md` (follow rules 1, 7, 10 especially)
- Call learnings schema: `src/db/schema/call-learnings.ts` (extend `analysis` field)

---

## Open Questions Worth Discussing Before Building

1. **What about non-binary or unknown-gender preferences?** Hebrew has no gender-neutral 
   grammatical forms. Options: (a) default to masculine (current), (b) alternate 
   between forms mid-conversation (feels weird), (c) invent a system prompt rule 
   like "use formal register that avoids second-person direct verbs where possible" 
   (advanced, may reduce naturalness). Decide before building.

2. **Voice-based gender detection?** Acoustic features (pitch, formants) can indicate 
   gender with ~90% accuracy. Not needed for MVP — name lookup + LLM inference is 
   sufficient. But worth flagging as a future upgrade if accuracy is disappointing.

3. **Multi-party calls?** If a call gets transferred or someone else joins, gender 
   detection needs to reset. Edge case, likely deferred.

4. **Manual override in dashboard?** Should human sales rep be able to correct the 
   gender before calling back a lead? Probably yes — flag for Phase 6 (dashboard work).
