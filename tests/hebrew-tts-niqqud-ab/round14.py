"""
Round 14 — every Hebrew sentence the 2026-09-01 branch adds, that nobody has heard yet.

Round 13 settled five cards by ear and the branch `feature/voice-call4-conclusions` applies all
five. Doing so introduced NEW speech, and the standing rule since round 4b is that an unscreened
Hebrew line is never shipped silently: a word that fails on an 8kHz line fails invisibly, and the
first person to find out is a lead.

So this page is not a re-run of anything. It is exactly the sentences this branch would put in a
caller's ear that Koren has never listened to:

  c1  the confirmation question the hang-up gate makes her ask INSTEAD of saying goodbye. It is the
      new sentence with the most at stake: it fires at the one moment a lead is about to be lost,
      and if it sounds abrupt it will lose him anyway.
  e2  the collision his own `e1` pick creates with the negation-safety rule. His chosen sentence
      rests on a bare "לא" — drop it on a phone line and "אתה לא היחיד ששואל את זה" becomes "you
      are the ONLY one who asks that". A is his wording, unchanged and shipped; B says the same
      thing with nothing to drop. Only his ear can settle which risk is worse.
  b1  the discovery opener that does not assume he has a business (his conclusion 3). A is what she
      said on the call and what he objected to.
  m1  what she says once, and only once, when a mandatory question has gone unanswered twice —
      instead of asking it a third and a fourth time, which is what she did on the call.
  d1  the end-of-call AI disclosure with one comma removed. Zero words changed; it is the `g1`
      lever applied to the other fixed sentence shaped like a greeting. It is also a compliance
      line, which is why it gets a card rather than a quiet edit.

A is always what production says TODAY where such a thing exists, so every card is a comparison
rather than a vote on something with no baseline.

Same instrument as round 13, deliberately: sonic-3.5 at the production speed and volume, every clip
run through `wavcheck.assert_playable` before it is offered. Writes round14.json and the page.
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
    ("c1", "hangup", "לפני שהיא סוגרת שיחה — מה היא שואלת", [
        ("A", "היום — היא פשוט נפרדת", "אז כנראה שזה לא הזמן הנכון. תודה ששיתפת אותי, ואם זה ישתנה בהמשך נשמח לדבר. שיהיה יום נעים."),
        ("B", "השאלה שהשער מכניס במקום הפרידה", "שאסגור את זה כרגע?"),
        ("C", "אותה שאלה, עם חצי משפט לפניה", "רגע לפני שנסיים — שאסגור את זה כרגע?"),
        ("D", "ניסוח ישיר יותר", "אתה רוצה שנעצור כאן?"),
    ]),
    ("e2", "empathy", "הבחירה שלךָ מול כלל ה־לא שנעלם", [
        ("A", "הבחירה שלךָ מסבב 13, כפי שנשלחה", "זה חשש הגיוני, ואתה לא היחיד ששואל את זה. בוא אני אראה לךָ בדמו איך זה נשמע בפועל ותחליט בעצמךָ."),
        ("B", "אותו דבר, בלי מילת שלילה שאפשר לפספס", "זה חשש הגיוני, והרבה בעלי עסקים שואלים את זה בדיוק ככה. בוא אני אראה לךָ בדמו איך זה נשמע בפועל ותחליט בעצמךָ."),
    ]),
    ("b1", "discovery", "לפני שהיא מניחה שיש לו עסק", [
        ("A", "היום — מניחה שיש עסק", "ספר לי קצת על העסק — במה אתה עוסק?"),
        ("B", "שאלה פתוחה קצרה", "יש לךָ עסק משלךָ?"),
        ("C", "שאלה פתוחה שנותנת לו את שתי האפשרויות", "אתה מנהל עסק, או שאתה עדיין בתחילת הדרך?"),
        ("D", "בלי הנחה בכלל", "במה אתה עוסק?"),
    ]),
    ("m1", "discovery", "כששאלה חובה נשארה בלי תשובה — פעמיים", [
        ("A", "היום — היא פשוט שואלת שוב", "כמה פניות חדשות אתה מקבל ביום, פלוס מינוס?"),
        ("B", "מוותרת בקול, פעם אחת", "בסדר, לא נתעכב על זה."),
        ("C", "מקטינה את השאלה במקום לחזור עליה", "בערך? חמש? עשרים?"),
    ]),
    ("d1", "compliance", "הגילוי בסוף השיחה — פסיק אחד", [
        ("A", "היום — עם פסיק", "רק שתדע, אני העוזרת הדיגיטלית של קורן — היה כיף לדבר!"),
        ("B", "בלי הפסיק, אותן מילים בדיוק", "רק שתדע אני העוזרת הדיגיטלית של קורן — היה כיף לדבר!"),
    ]),
]

INTRO = """
כל משפט כאן הוא משפט חדש שהענף הזה שם בפה שלה, ו<b>שעוד לא שמעת</b>.
<b>A זה תמיד מה שנאמר היום</b>, איפה שיש כזה דבר.<br>
sonic-3.5, מהירות 0.9, עוצמה 1.4 — בדיוק כמו בפרודקשן, דרך פס טלפון.<br><br>
<b>הכרטיס הכי חשוב הוא c1</b>: זה מה שהיא תשאל במקום להיפרד, ברגע שבו כמעט איבדנו אותךָ בשיחה
האחרונה.<br>
<b>ו־e2 הוא התנגשות אמיתית</b>: הבחירה שלךָ מסבב 13 נשענת על "לא" אחד לא מודגש, ואם הוא נופל בקו
טלפון המשפט מתהפך ל"אתה היחיד ששואל את זה". A היא הבחירה שלךָ כפי שנשלחה; B אומרת אותו דבר בלי
משהו שאפשר לפספס. רק האוזן שלךָ יכולה להכריע מה גרוע יותר.
"""

CARD_NOTES = {
    "c1": "השער החדש מסרב לנתק ליד כשההחלטה נשענת על דיבור מעל הקול שלה, על הד של המילים שלה עצמה, או על פרשנות — ומכניס את השאלה הזאת במקום הפרידה. אם היא נשמעת חדה מדי, נאבד אותו בכל זאת.",
    "e2": "ההבדל הוא מילה אחת: <code>לא</code>. אם הקו מפיל אותה, A מתהפך למשפט ההפוך והמזיק. B אומרת את אותו דבר בלי שום דבר שאפשר לפספס. <b>A היא מה שנשלח בקוד עכשיו</b> — כי זו הבחירה שלךָ.",
    "b1": "בשיחה שאלת אותה \"איך את יודעת שיש לי עסק?\". בשיחה הקודמת ההנחה רצה לכיוון ההפוך והיא כמעט פסלה מישהו שאין לו עדיין עסק.",
    "m1": "היא שאלה \"כמה פניות ביום\" ארבע פעמים ולא קיבלה תשובה אף פעם. הכלל החדש הוא שתי שאלות לכל היותר — ואז אחת מהשתיים האלה.",
    "d1": "אותו מהלך של <code>g1</code>, על המשפט הקבוע השני שבנוי כמו הצגה עצמית. אף מילה לא השתנתה. זה גם משפט ציות (גילוי שהיא AI), ולכן הוא מקבל כרטיס ולא עריכה שקטה.",
}

STYLE = """<style>
:root{--bg:#0f1115;--fg:#e8eaed;--mut:#9aa0a6;--card:#171a21;--line:#262b36;--acc:#7c8cff}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,Segoe UI,Arial;padding:28px}
h1{font-size:22px;margin:0 0 6px} h2{font-size:16px;margin:0 0 8px;color:var(--acc)}
.intro{max-width:72ch;color:var(--mut);margin-bottom:26px} .intro b{color:var(--fg)}
.note{color:var(--mut);font-size:13px;margin-bottom:12px;max-width:74ch} .note b{color:var(--fg)}
code{background:#12151c;border:1px solid var(--line);border-radius:4px;padding:0 5px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.vs{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(290px,1fr))}
.v{border:1px solid var(--line);border-radius:8px;padding:12px;background:#12151c}
.k{display:inline-block;font-weight:700;background:var(--acc);color:#0f1115;border-radius:4px;padding:0 8px;margin-bottom:6px}
.lab{color:var(--mut);font-size:13px;margin-bottom:6px} .txt{font-size:15px;margin-bottom:10px}
audio{width:100%} .pick{display:block;margin-top:8px;font-size:13px;cursor:pointer}
button{background:var(--acc);color:#0f1115;border:0;border-radius:8px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}
pre{background:#12151c;border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap}
</style>"""


def build_page(manifest):
    out = ['<meta charset="utf-8"><title>סבב 14 — המשפטים החדשים שעוד לא שמעת</title>', STYLE]
    out.append('<h1>סבב 14 — המשפטים החדשים שעוד לא שמעת</h1>')
    out.append(f'<div class="intro" dir="rtl">{INTRO}</div>')
    for card in manifest["cards"]:
        note = CARD_NOTES.get(card["id"], "")
        out.append(f'<section><h2>{card["id"]} · {card["word"]}</h2>')
        out.append(f'<div class="note" dir="rtl">{note}</div><div class="vs">')
        for v in card["variants"]:
            out.append(
                f'<div class="v"><div class="k">{v["key"]}</div>'
                f'<div class="lab">{v["label"]}</div>'
                f'<div class="txt" dir="rtl">{v["text"]}</div>'
                f'<audio controls preload="none" src="{v["file"]}"></audio>'
                f'<label class="pick"><input type="radio" name="pick_{card["id"]}" '
                f'value="{v["key"]}"> זה הכי טוב</label></div>'
            )
        out.append('</div></section>')
    ids = json.dumps([c["id"] for c in manifest["cards"]])
    out.append('<button onclick="s()">צור סיכום</button><pre id="out" dir="ltr"></pre>')
    out.append(
        "<script>\nfunction s(){\n  const ids=" + ids + ";\n"
        "  const lines=ids.map(id=>{\n"
        "    const el=document.querySelector('input[name=\"pick_'+id+'\"]:checked');\n"
        "    return id+' = '+(el?el.value:'—');\n"
        "  });\n  document.getElementById('out').textContent=lines.join('\\n');\n}\n</script>"
    )
    return "\n".join(out)


def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}
    for cid, section, word, variants in CARDS:
        card = {"id": cid, "section": section, "word": word, "variants": []}
        for key, label, text in variants:
            fname = f"r14_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            synthmod.synth(text, path)
            wavcheck.assert_playable(path)   # never hand over a clip that will not play
            card["variants"].append({"key": key, "label": label, "text": text, "file": fname})
            print(f"  {fname}  ok")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round14.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round14.json")
    with open(os.path.join(HERE, "index-round14.html"), "w", encoding="utf-8") as f:
        f.write(build_page(manifest))
    print("wrote index-round14.html")


if __name__ == "__main__":
    main()
