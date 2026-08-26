"""
Round 3d — רוצה (rotsE m / rotsA f), on sonic-3.5. Added on Koren's report (2026-08-26 evening).

  rm  addressee masc:  אתה רוצה     A plain vs C segol (רוצֶה)
  rf  addressee fem:   את רוצה      A plain vs C kamatz (רוצָה)
  rs  agent self (f):  אני רוצה     A plain vs C kamatz + the existing לוודֵא fix
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env
from round3 import dur

synthmod.MODEL = load_env("CARTESIA_MODEL")

SEGOL, KAMATZ = "ֶ", "ָ"

CARDS = [
    ("rm", "רוצה (פנייה לזכר)", [
        ("A", "רגיל", "אתה רוצה לשמוע עוד פרטים?"),
        ("C", "סגול (רוצֶה)", f"אתה רוצ{SEGOL}ה לשמוע עוד פרטים?"),
    ]),
    ("rf", "רוצה (פנייה לנקבה)", [
        ("A", "רגיל", "את רוצה לשמוע עוד פרטים?"),
        ("C", "קמץ (רוצָה)", f"את רוצ{KAMATZ}ה לשמוע עוד פרטים?"),
    ]),
    ("rs", "רוצה (הסוכנת על עצמה)", [
        ("A", "רגיל", "אני רוצה לוודא שהבנתי נכון."),
        ("C", "קמץ + לוודֵא", f"אני רוצ{KAMATZ}ה לוודֵא שהבנתי נכון."),
    ]),
]

def main():
    print(f"model: {synthmod.MODEL}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    for cid, word, variants in CARDS:
        card = {"id": cid, "section": "m", "word": word, "variants": []}
        for key, label, text in variants:
            fname = f"r3_{cid}_{key}.wav"
            synth(text, os.path.join(HERE, fname))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": fname, "dur": round(dur(os.path.join(HERE, fname)), 2)})
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round3d.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round3d.json")

if __name__ == "__main__":
    main()
