"""
Round 5 — the SPOKEN-NUMBER word forms + the SPOKEN_REGISTER slang candidates (2026-08-27).

Two gates ride this round:
  1. speech-numbers.he.ts ships digits→words ("16:30" → "ארבע וחצי"). Every new spoken form must
     survive the same verification as the round-3 pronunciation marks: synth → 8kHz phone band →
     Soniox → the intended words heard back, plus Koren's ear on the listening page. The feminine
     hour forms are the ones to watch (ארבע וחצי, רבע לחמש, עשר וחמישה).
  2. The written-laughter lesson (round 4b): an LLM-favoured spelling can be unpronounceable on
     sonic-3.5. So every slang candidate for the SPOKEN_REGISTER bank is screened HERE before it
     is allowed into the prompt. What fails is dropped and noted in the handoff.

  python tests/hebrew-tts-niqqud-ab/round5.py          # synth all clips + round5.json
  npx tsx tests/hebrew-tts-niqqud-ab/roundtrip5.ts     # phone-band Soniox round-trip
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env
from round3 import dur

# PINNED to the model production actually speaks (sonic-3.5, the Hebrew default since
# 2026-08-05) — NOT load_env("CARTESIA_MODEL"): the local .env in this worktree carries a stale
# sonic-3 from another session, and a verdict table on the wrong model is worse than none.
synthmod.MODEL = os.environ.get("ROUND5_MODEL", "sonic-3.5")

# (id, what it screens, sentence, accepted round-trip fragments — ANY match passes; Soniox may
# write a spoken number back as digits, so digit spellings are accepted alongside the words)
CARDS = [
    # -- clock times (feminine hours; the complaint verbatim was 16:30) --
    # Soniox's inverse-text-normalization may write a heard number back as digits in several
    # shapes ("ארבע וחצי" → "4 וחצי", "מעשר עד שלוש" → "מ-10:00 עד 3:00") — each is proof the
    # words carried through the phone band; all observed spellings are accepted.
    ("t1", "16:30 → ארבע וחצי",      "נתראה מחר בארבע וחצי.",            ["ארבע וחצי", "4 וחצי", "4:30", "16:30"]),
    ("t2", "16:45 → רבע לחמש",       "אפשר גם רבע לחמש.",                 ["רבע לחמש", "רבע ל-5", "4:45", "16:45"]),
    ("t3", "10:05 → עשר וחמישה",     "הפגישה מתחילה בעשר וחמישה.",        ["עשר וחמישה", "10:05"]),
    ("t4", "טווח → מעשר עד שלוש",    "יש לי פנוי מעשר עד שלוש.",          ["מעשר עד שלוש", "עשר עד שלוש", "10:00 עד 3", "10 עד 3", "10:00 עד 15:00"]),
    ("t5", "16:15 → ארבע ורבע",      "נדבר בארבע ורבע.",                  ["ארבע ורבע", "4 ורבע", "4:15"]),
    ("t6", "20:00 → שמונה בערב",     "אתקשר אליך בשמונה בערב.",           ["שמונה בערב", "8 בערב"]),
    ("t7", "16:50 → עשרה לחמש",      "בוא נסגור על עשרה לחמש.",           ["עשרה לחמש", "10 ל-5", "4:50"]),
    ("t8", "16:20 → ארבע ועשרים",    "נקבע לארבע ועשרים.",                ["ארבע ועשרים", "4:20", "04:20"]),
    # -- phone read-out (feminine digits, grouped) --
    ("p1", "טלפון ספרה-ספרה",        "המספר הוא אפס חמש אפס, אחת שתיים שלוש ארבע, חמש שש שבע.",
                                      ["אפס חמש אפס", "050"]),
    # -- price + counted nouns --
    ("pr1", "500 שקל → חמש מאות",    "זה עולה חמש מאות שקל לחודש.",       ["חמש מאות שקל", "500 שקל", "500 ש"]),
    ("si1", "5 דקות → חמש דקות",     "זה לוקח בערך חמש דקות.",            ["חמש דקות", "5 דקות"]),
    ("si2", "3 ימים → שלושה ימים",   "ההקמה לוקחת שלושה ימים.",           ["שלושה ימים", "3 ימים"]),
    # -- slang candidates for SPOKEN_REGISTER (screened BEFORE they enter the bank) --
    ("s1", "סבבה",                    "סבבה, אז נתקדם.",                   ["סבבה"]),
    ("s2", "אחלה",                    "אחלה, מתי נוח לך?",                 ["אחלה"]),
    ("s3", "מעולה",                   "מעולה, אז סגרנו.",                  ["מעולה"]),
    ("s4", "בקטנה",                   "אפשר להתחיל בקטנה ולראות איך זה עובד.", ["בקטנה"]),
    ("s5", "על הדרך",                 "ועל הדרך אפשר לחבר גם את הוואטסאפ.", ["על הדרך"]),
]

def main():
    print(f"model: {synthmod.MODEL}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    for cid, what, text, hear in CARDS:
        fname = f"r5_{cid}_B.wav"  # key B: a candidate under test (roundtrip skips only key A)
        # Existing clips are kept — the round-trip verdicts and Koren's ear must judge the SAME
        # audio. Delete a wav (or pass --resynth) to regenerate it.
        if "--resynth" in sys.argv or not os.path.exists(os.path.join(HERE, fname)):
            synth(text, os.path.join(HERE, fname))
        manifest["cards"].append({"id": cid, "section": "r5", "word": what, "hear": hear,
            "variants": [{"key": "B", "label": what, "text": text, "file": fname,
                          "dur": round(dur(os.path.join(HERE, fname)), 2)}]})
        print(f"  {cid}  {text}")
    json.dump(manifest, open(os.path.join(HERE, "round5.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round5.json")

if __name__ == "__main__":
    main()
