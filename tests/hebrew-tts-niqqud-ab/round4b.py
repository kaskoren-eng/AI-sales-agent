"""
Round 4b — the wider emotion palette as SPEAKABLE TEXT (tags are dead; round 4).

Screening, not A/B: does sonic-3.5 render each written vocalization naturally in Hebrew,
or does it spell it out / produce a weird sound? ok/bad per clip.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env
from round3 import dur

synthmod.MODEL = load_env("CARTESIA_MODEL")

CARDS = [
    ("w1", "צחוק כתוב — חח",   "חח, זה באמת מצחיק."),
    ("w2", "צחוק כתוב — חהחה", "חהחה, לא ציפיתי לזה."),
    ("w3", "אנחה — אוף",       "אוף... זה באמת מבאס."),
    ("w4", "אנחה — אוו",       "אוו... אני מבינה אותך לגמרי."),
    ("w5", "שמחה — איזה כיף",  "איזה כיף! ממש שמחה לשמוע."),
    ("w6", "הפתעה — וואלה",    "וואלה? זה ממש מעניין."),
]

def main():
    print(f"model: {synthmod.MODEL}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    for cid, word, text in CARDS:
        fname = f"r4_{cid}_A.wav"
        synth(text, os.path.join(HERE, fname))
        manifest["cards"].append({"id": cid, "section": "ps", "word": word, "variants": [
            {"key": "A", "label": "רגיל", "text": text, "file": fname,
             "dur": round(dur(os.path.join(HERE, fname)), 2)}]})
        print(f"  {cid}  {text}")
    json.dump(manifest, open(os.path.join(HERE, "round4b.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round4b.json")

if __name__ == "__main__":
    main()
