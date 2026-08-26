"""
Round 4 — EMOTION on sonic-3.5 Hebrew (2026-08-26 evening).

Cartesia support says emotion tags are not supported for Hebrew. Three questions the ear can
answer that support tickets cannot:

  T  tags:        is an inline [laughter]/[sigh] in Hebrew text IGNORED (harmless), SPOKEN
                  ALOUD (must never reach the prompt), or RENDERED (jackpot)?
  P  punctuation: sonic reads the emotional subtext of the text — do !!, …, and an interjection
                  actually change the Hebrew delivery? (p3 targets the flat question-intonation
                  Koren flagged in round 3's ps4.)
  E  phrasing:    the thing a prompt instruction would really produce — the same sales beat
                  written neutral vs emotionally colored. If E wins, the fix is a SHORT prompt
                  instruction, not a TTS knob.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env
from round3 import dur

synthmod.MODEL = load_env("CARTESIA_MODEL")

CARDS = [
    # -- T · inline tags ---------------------------------------------------------
    ("t1", "T", "[laughter]", [
        ("A", "בלי תג", "זה מצוין, באמת שמחתי לשמוע."),
        ("B", "עם [laughter]", "זה מצוין! [laughter] באמת שמחתי לשמוע."),
    ]),
    ("t2", "T", "[sigh]", [
        ("A", "בלי תג", "אני מבינה, זה באמת מתסכל."),
        ("B", "עם [sigh]", "אני מבינה, [sigh] זה באמת מתסכל."),
    ]),
    # -- P · punctuation as prosody ----------------------------------------------
    ("p1", "P", "התלהבות", [
        ("A", "נייטרלי", "מעולה. נקבע לשבוע הבא."),
        ("B", "סימני קריאה", "מעולה!! נקבע לשבוע הבא!"),
        ("C", "קריאת ביניים + קריאה", "וואו, מעולה! נקבע לשבוע הבא!"),
    ]),
    ("p2", "P", "אמפתיה / האטה", [
        ("A", "נייטרלי", "אני מבינה שזה מתסכל."),
        ("B", "שלוש נקודות", "אני מבינה... זה באמת מתסכל."),
    ]),
    ("p3", "P", "אינטונציית שאלה (ps4)", [
        ("A", "רגיל", "באיזו שעה נוח לך?"),
        ("B", "סימן שאלה כפול", "באיזו שעה נוח לך??"),
        ("C", "ניסוח עם ברירה", "מתי הכי נוח לך — בבוקר, או אחר הצהריים?"),
    ]),
    # -- E · emotionally colored phrasing (what the prompt would produce) ---------
    ("e1", "E", "התלהבות במכירה", [
        ("A", "נייטרלי", "אנחנו יכולים לעזור לך עם זה. נקבע פגישה?"),
        ("B", "צבוע רגשית", "אה, זה בדיוק מה שאנחנו עושים! שמחה שסיפרת לי. נקבע פגישה?"),
    ]),
    ("e2", "E", "אמפתיה במכירה", [
        ("A", "נייטרלי", "הבנתי. לידים שמתפספסים זו בעיה."),
        ("B", "צבוע רגשית", "אוף, אני לגמרי מבינה אותך... כל ליד שמתפספס זה כסף על השולחן."),
    ]),
]

def main():
    print(f"model: {synthmod.MODEL}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    for cid, section, word, variants in CARDS:
        card = {"id": cid, "section": section, "word": word, "variants": []}
        for key, label, text in variants:
            fname = f"r4_{cid}_{key}.wav"
            synth(text, os.path.join(HERE, fname))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": fname, "dur": round(dur(os.path.join(HERE, fname)), 2)})
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round4.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round4.json")

if __name__ == "__main__":
    main()
