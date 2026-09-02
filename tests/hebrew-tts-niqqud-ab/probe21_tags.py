"""
Round 20 probe — do English breath tags DO anything on Hebrew Cartesia, before anyone listens?

Koren, 2026-09-02: *"תנסה קודם את הקיים בקרטסיה אולי נצליח איכשהו לעבוד עם תגים באנגלית"* — so this
file asks Cartesia directly, before a single card is built. Round 4 (2026-08-26) already found
`[laughter]`/`[sigh]`-style tags silently swallowed on Hebrew sonic — but that verdict predates
sonic-3.6 (Aug 2026), the snapshot Cartesia now markets the non-verbal tags on. A dead verdict is
re-dated, not trusted forever.

THE DIAGNOSIS IS MECHANICAL, and it runs before any ear:
  - INERT tag  -> clip duration ~= the plain variant (the tag is stripped server-side; nothing to hear)
  - HONOURED   -> clip is 200-600ms longer (a breath takes time)
  - READ ALOUD -> roundtrip21.ts hears an English word Soniox writes back — the worst case, and the
                  one a duration table alone cannot separate from "honoured" (roundtrip17.ts's `br`
                  lesson, verbatim).
Only a variant that is (longer) AND (not read aloud) earns a place on Koren's listening page.

The sentence is round-18 `pr`'s pricing reply — the live prompt's own words, two sentences, the
exact kind of long turn a person would breathe into.

  python tests/hebrew-tts-niqqud-ab/probe21_tags.py
"""
import json, os, struct, sys, wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod

HERE = os.path.dirname(os.path.abspath(__file__))

# Production parity — the same knobs round 16-19 used (speed 0.9 / volume 1.4 = the live agent).
synthmod.GENERATION_CONFIG = {"speed": 0.9, "volume": 1.4}

# The two sentences of round-18 `pr`, un-tagged. S1/S2 kept separate so the mid-reply tag position
# is the real seam between them, not an invented one.
S1 = "המחיר נקבע לפי כמה שיחות הסוכן מנהל בשבילךָ."
S2 = "כמה פניות נכנסות אליךָ בחודש?"
PLAIN = f"{S1} {S2}"

# English tags, per Koren's ask. Bracket forms are what sonic-3.6's marketing shows for
# [laughter]; the parenthesized form is a common alternative grammar worth one slot.
VARIANTS = [
    ("A", "plain (baseline)",            PLAIN),
    ("B", "[breath] prefix",             f"[breath] {PLAIN}"),
    ("C", "[inhales] prefix",            f"[inhales] {PLAIN}"),
    ("D", "[breathing] mid-reply",       f"{S1} [breathing] {S2}"),
    ("E", "[sigh] prefix",               f"[sigh] {PLAIN}"),
    ("F", "(breathes) prefix",           f"(breathes) {PLAIN}"),
]

# sonic-3.5 is production; sonic-3.6 is the snapshot the tags are marketed on. If Cartesia
# rejects an id outright that is itself a finding — print it and keep going.
MODELS = ["sonic-3.5", "sonic-3.6"]


def duration_ms(path):
    with wave.open(path, "rb") as w:
        return round(w.getnframes() / w.getframerate() * 1000)


def main():
    results = []
    for model in MODELS:
        synthmod.MODEL = model
        mkey = model.replace("sonic-3.", "m")  # m5 / m6
        base_ms = None
        for key, label, text in VARIANTS:
            out = os.path.join(HERE, f"r21_{mkey}_{key}.wav")
            try:
                synthmod.synth(text, out)
            except SystemExit as err:
                print(f"{model} {key} ({label}): SYNTH FAILED — {err}")
                results.append({"model": model, "key": key, "label": label, "text": text,
                                "file": None, "ms": None, "delta_ms": None, "error": str(err)})
                continue
            ms = duration_ms(out)
            if key == "A":
                base_ms = ms
            delta = None if base_ms is None else ms - base_ms
            results.append({"model": model, "key": key, "label": label, "text": text,
                            "file": os.path.basename(out), "ms": ms, "delta_ms": delta})
            flag = ""
            if key != "A" and delta is not None:
                flag = "  <-- SOMETHING RENDERED" if delta >= 150 else "  (inert?)"
            print(f"{model} {key} ({label}): {ms}ms  delta={delta if delta is not None else '—'}ms{flag}")

    json.dump({"sentence": PLAIN, "results": results},
              open(os.path.join(HERE, "probe21.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("\nwrote probe21.json — durations are evidence, not a verdict. Next: roundtrip on any")
    print("variant that rendered, to separate 'honoured' from 'read aloud'.")


if __name__ == "__main__":
    main()
