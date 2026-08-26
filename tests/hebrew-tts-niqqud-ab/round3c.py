"""
Round 3c — masculine איתך / בשבילך / עבורך, third attempt (sonic-3.5).

Round 3b rejected BOTH options for these words (bm3/bm4/bm5: plain bad, kamatz bad).
The table meanwhile reverted to the pre-round-3 respelling (איתכה) that shipped in production.
This round scores that fallback for the first time on sonic-3.5, against a patach variant:

  B  the כה respelling (current production fallback — never ear-scored on 3.5)
  D  minimal niqqud, patach on the final kaf (ךַ — same "a" vowel as the rejected kamatz,
     different mark; some voices render the two differently)
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env
from round3 import dur

synthmod.MODEL = load_env("CARTESIA_MODEL")

PATACH = "ַ"

WORDS = [
    ("c1", "איתך",   "איתכה",   f"איתך{PATACH}",   "נעים לדבר {w}."),
    ("c2", "בשבילך", "בשבילכה", f"בשבילך{PATACH}", "הכנתי משהו {w}."),
    ("c3", "עבורך",  "עבורכה",  f"עבורך{PATACH}",  "יש לי הצעה מיוחדת {w}."),
]

def main():
    print(f"model: {synthmod.MODEL}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    for cid, word, resp, patach, tpl in WORDS:
        card = {"id": cid, "section": "m", "word": f"{word} (זכר)", "variants": []}
        for key, label, w in [("B", "איות כה (ההפקה כיום)", resp), ("D", "ניקוד פתח (ךַ)", patach)]:
            text = tpl.format(w=w)
            fname = f"r3_{cid}_{key}.wav"
            synth(text, os.path.join(HERE, fname))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": fname, "dur": round(dur(os.path.join(HERE, fname)), 2)})
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round3c.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round3c.json")

if __name__ == "__main__":
    main()
