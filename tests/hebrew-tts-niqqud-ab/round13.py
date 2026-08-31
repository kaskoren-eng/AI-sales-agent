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
    ("g1", "flow", "הפתיחה — כמה פסיקים היא צריכה", [
        ("A", "היום — שני פסיקים ונקודה", "שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"),
        ("B", "בלי פסיקים בכלל", "שלום מדברת קרן העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"),
        ("C", "בלי פסיקים וגם בלי הנקודה באמצע", "שלום מדברת קרן העוזרת הדיגיטלית של ClickScales — איך אני יכולה לעזור?"),
    ]),
    ("p1", "flow", "משפט ארוך — פסיקים מול משפטים קצרים", [
        ("A", "היום — שרשרת פסיקים", "אנחנו בונים סוכני AI לקול ולוואטסאפ, שעונים לפניות של לקוחות, קובעים שיחות ועוזרים לעסק להגיב מהר יותר לכל ליד."),
        ("B", "אותו תוכן, שלושה משפטים קצרים", "אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים לפניות של לקוחות וקובעים שיחות. ככה כל ליד מקבל מענה מהר."),
        ("C", "מקפים במקום פסיקים", "אנחנו בונים סוכני AI לקול ולוואטסאפ — הם עונים לפניות וקובעים שיחות — וככה כל ליד מקבל מענה מהר."),
    ]),
    ("s1", "slang", "בקטנה — סלנג נכון בצליל, שגוי במשמעות", [
        ("A", "היום — השימוש השגוי שתפסת", "אז איזה עסק יש לךָ, בקטנה?"),
        ("B", "בקצרה — המילה הנכונה", "אז ספר לי בקצרה — איזה עסק יש לךָ?"),
        ("C", "בלי מילת קיצור בכלל", "אז איזה עסק יש לךָ?"),
    ]),
    ("s2", "slang", "תיאור פיצ׳ר — סלנג מול מילה חיובית חד־משמעית", [
        ("A", "היום — אחלה", "זה עובד אחלה לעסקים שרוצים שכל פנייה תקבל מענה."),
        ("B", "מעולה", "זה עובד מעולה לעסקים שרוצים שכל פנייה תקבל מענה."),
        ("C", "מצוין", "זה עובד מצוין לעסקים שרוצים שכל פנייה תקבל מענה."),
        ("D", "טוב מאוד", "זה עובד טוב מאוד לעסקים שרוצים שכל פנייה תקבל מענה."),
    ]),
    ("e1", "empathy", "הוא מביע חשש — מה היא אומרת ראשון", [
        ("A", "היום — ישר להפרכה, בלי הזדהות", "אנחנו בונים סוכנים שנשמעים ומתנהגים כמו בני אדם, לא תסריט קבוע."),
        ("B", "הזדהות קצרה ואז התשובה", "אני מבינה אותךָ לגמרי — הלידים האלה עלו לךָ כסף. בדיוק בגלל זה בנינו את זה ככה שהשיחה תישמע טבעית."),
        ("C", "הזדהות שמכירה בחשש כלגיטימי", "זה חשש הגיוני, ואתה לא היחיד ששואל את זה. בוא אני אראה לךָ בדמו איך זה נשמע בפועל ותחליט בעצמךָ."),
    ]),
]

def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}
    for cid, section, word, variants in CARDS:
        card = {"id": cid, "section": section, "word": word, "variants": []}
        for key, label, text in variants:
            fname = f"r13_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            synthmod.synth(text, path)
            wavcheck.assert_playable(path)   # never hand over a clip that will not play
            card["variants"].append({"key": key, "label": label, "text": text, "file": fname})
            print(f"  {fname}  ok")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round13.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round13.json")

if __name__ == "__main__":
    main()
