"""
Round 3b — supplement to round 3: the REMAINING 2nd-person suffix words, on sonic-3.5.

Round 3 verdicts settled לך/שלך (masc: minimal kamatz; fem: לָךְ minimal / שלאך respelling).
This round covers the other five words in the speech-guard table so the full masculine table
can switch to kamatz, and the new feminine table gets ear-verified per-word choices:

  masc: plain vs minimal kamatz (the round-3 winner pattern, per-word confirmation)
  fem:  plain vs phonetic respelling vs minimal niqqud (round 3 split — decide per word)
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env
from round3 import dur

synthmod.MODEL = load_env("CARTESIA_MODEL")

TSERE, KAMATZ, SHEVA, PATACH, HIRIQ = "ֵ", "ָ", "ְ", "ַ", "ִ"

# fem candidates: (respelling, minimal-niqqud)
WORDS = [
    # word, masc-kamatz, fem-respell, fem-minimal, sentence template ({w} = the word)
    ("אותך",   f"אותך{KAMATZ}",   "אותאך",   f"אות{KAMATZ}ך{SHEVA}",   "נעים מאוד להכיר {w}."),
    ("אליך",   f"אליך{KAMATZ}",   "אלייך",   f"אל{PATACH}י{HIRIQ}ך{SHEVA}", "אני אחזור {w} עוד היום."),
    ("איתך",   f"איתך{KAMATZ}",   "איתאך",   f"אית{KAMATZ}ך{SHEVA}",   "נעים לדבר {w}."),
    ("בשבילך", f"בשבילך{KAMATZ}", "בשבילאך", f"בשביל{TSERE}ך{SHEVA}",  "הכנתי משהו {w}."),
    ("עבורך",  f"עבורך{KAMATZ}",  "עבוראך",  f"עבור{TSERE}ך{SHEVA}",   "יש לי הצעה מיוחדת {w}."),
]

def main():
    print(f"model: {synthmod.MODEL}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    for i, (word, masc_k, fem_r, fem_m, tpl) in enumerate(WORDS, 1):
        # masculine card: A plain vs C kamatz
        mcard = {"id": f"bm{i}", "section": "m", "word": f"{word} (זכר)", "variants": []}
        for key, label, w in [("A", "רגיל, בלי תיקון", word), ("C", "ניקוד מינימלי (ךָ)", masc_k)]:
            text = tpl.format(w=w)
            fname = f"r3_bm{i}_{key}.wav"
            synth(text, os.path.join(HERE, fname))
            mcard["variants"].append({"key": key, "label": label, "text": text,
                                      "file": fname, "dur": round(dur(os.path.join(HERE, fname)), 2)})
            print(f"  bm{i}_{key}  {text}")
        manifest["cards"].append(mcard)
        # feminine card: A plain vs B respelling vs C minimal niqqud
        fcard = {"id": f"bf{i}", "section": "f", "word": f"{word} (נקבה)", "variants": []}
        for key, label, w in [("A", "רגיל, בלי תיקון", word),
                              ("B", "איות פונטי", fem_r),
                              ("C", "ניקוד מינימלי", fem_m)]:
            text = tpl.format(w=w)
            fname = f"r3_bf{i}_{key}.wav"
            synth(text, os.path.join(HERE, fname))
            fcard["variants"].append({"key": key, "label": label, "text": text,
                                      "file": fname, "dur": round(dur(os.path.join(HERE, fname)), 2)})
            print(f"  bf{i}_{key}  {text}")
        manifest["cards"].append(fcard)
    json.dump(manifest, open(os.path.join(HERE, "round3b.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round3b.json")

if __name__ == "__main__":
    main()
