"""
Round 12 — the two sentences the false-booking guard speaks, which nobody has ever heard.

Both were written on 2026-08-31 to fix a real defect: at 273s of that day's 16:51 call she said
"קבענו לאחת עשרה" — "we've booked for eleven" — when nothing had been booked. The guard now
rewrites that claim into the truth. But a guard only fires on a defect, so its replacement text
is the one thing on a call NOBODY has listened to. Per Koren's rule of 2026-08-31, it gets a
listening page before it reaches a caller, not after.

  A = what she said on the call (the false claim)
  B = what the guard makes her say instead

Card t1 is the mid-collection case: she has not booked YET and is three questions away from it.
Card t2 is the no-way-to-book case: the request goes to the team, and that ends the transaction.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod
import wavcheck

# Production speaks sonic-3.5 at VOICE_TTS_SPEED/VOLUME. A clip synthesized at 1.0/1.0 is not
# the thing the caller hears, and this page exists precisely to hear what he will hear.
synthmod.MODEL = "sonic-3.5"
synthmod.GENERATION_CONFIG = {"speed": 0.9, "volume": 1.4}

HERE = os.path.dirname(os.path.abspath(__file__))

CARDS = [
    ("t1", "guard", "היא עוד לא קבעה — מה היא אומרת במקום ההבטחה", [
        ("A", "מה שנאמר בשיחה (273s) — הבטחה על פגישה שלא קיימת",
         "קבענו לאחת עשרה. קורן, מה השם המלא שלךָ?"),
        ("B", "אחרי השינוי — האמת, שהיא גם הצעד הבא",
         "אני צריכה עוד כמה פרטים לפני שאני קובעת. קורן, מה השם המלא שלךָ?"),
    ]),
    ("t2", "guard", "אין דרך לקבוע — המשפט שמעביר לצוות", [
        ("A", "מה שנאמר בשיחה קודמת — הבטחה + אישור שלא יגיע",
         "קבעתי לך שיחת דמו למחר. תקבל אישור, תודה רבה ונדבר!"),
        ("B", "אחרי השינוי — מה שבאמת קורה",
         "אעביר את הבקשה לצוות ונחזור אליך לאישור מדויק."),
    ]),
]

def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}
    for cid, section, word, variants in CARDS:
        card = {"id": cid, "section": section, "word": word, "variants": []}
        for key, label, text in variants:
            fname = f"r12_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            synthmod.synth(text, path)
            wavcheck.assert_playable(path)   # never hand over a clip that will not play
            card["variants"].append({"key": key, "label": label, "text": text, "file": fname})
            print(f"  {fname}  ok")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round12.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round12.json")

if __name__ == "__main__":
    main()
