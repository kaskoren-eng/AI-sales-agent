"""
Round 7 — Koren's nine notes from the 2026-08-31 production call, as audio he can judge.

Every card is the SAME MOMENT of that call twice: **A is what he actually heard** (copied out of
`call-reports/calls-2026-08-31.md`, including the niqqud speech-guard.ts adds on the way to the
TTS), and **B is what the agent says after this change**. Nothing here is a hypothesis about how a
word is pronounced — rounds 3-6 did that. This round asks one question per card: *is the new line
better on the ear than the old one?*

Which is the only question that can be asked, because a prompt change is invisible to every test in
the repo and audible only on a call.

  n1  note 1 — the verification preamble ("רק לוודא" / "רק שאדע"). REMOVED, not re-spelled: round 6
                already proved both spellings come back through the phone band as "רק לוועדה".
  n2  note 2 — the comma inside "נעים מאוד, קורן". A is the call; B is one unbroken phrase.
  n3  note 3 — his own words handed back with a compliment on top ("בניית אתרים זה תחום מעניין").
  n4  note 4 — two filler noises in one breath ("אהה. רגע...").
  n5  note 5 — THE CONTROL. He asked to KEEP the emotional beat and the opening slang. A and B are
                deliberately the same act; if these two now sound worse, this change broke something
                it was told not to touch.
  n6  note 6 — "טוב, הבנתי" on a turn that earned nothing, and the same words on a turn that did.
  n7  note 7 — small talk before the business questions.
  n9  note 9 — "מחיר זה חשוב" in front of the price answer.
  sg  `סגור`, which he added to the slang bank himself. Every other word in that bank went through
                round 5 before it was allowed in, because an unscreened Hebrew word fails silently;
                this one goes through the same gate here (roundtrip7.ts — 3/3 came back intact).

MEASURED WHILE BUILDING THIS PAGE (roundtrip7.ts, the n1 clips): "רק לוודֵא" came back from Soniox
as **"רק לוועדה"** in two of its three carriers and survived in the third. Intermittent, which is
precisely the "לא תמיד נכון" Koren reported on 2026-08-30 — and the reason note 1 is a deletion
rather than a fourth attempt at spelling it.

PRODUCTION PARITY — sonic-3.5 at VOICE_TTS_SPEED=0.9 / VOICE_TTS_VOLUME=1.4, like round 6. A page
about phrasing synthesized at a different tempo from the live agent would be answering a different
question.

    python tests/hebrew-tts-niqqud-ab/round7.py     # synth + write index-round7.html
    python tests/hebrew-tts-niqqud-ab/round7.py --resynth    # regenerate every clip
"""
import html as htmlmod
import json
import os
import sys

# The Windows console this repo is developed on is cp1252, and every line this script prints is
# Hebrew. Without this the run dies on the FIRST progress line — after it has already paid Cartesia
# for the clip. (round6.py has the same prints and the same hazard; it happened to be run from a
# UTF-8 console.)
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover — a stdout that cannot be reconfigured is still usable
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth
from round3 import dur

synthmod.MODEL = os.environ.get("ROUND7_MODEL", "sonic-3.5")
synthmod.GENERATION_CONFIG = {
    "speed": float(os.environ.get("ROUND7_SPEED", "0.9")),
    "volume": float(os.environ.get("ROUND7_VOLUME", "1.4")),
}

# (card_id, section, what it asks, [(key, label, text)], [accepted round-trip fragments])
#
# `hear` is for roundtrip7.ts. Most cards leave it EMPTY on purpose: this round compares two
# PHRASINGS, and Soniox has no opinion about which of two well-formed Hebrew sentences sounds
# less robotic. Only two claims here are machine-checkable — that "רק לוודֵא" does not survive the
# phone band (the reason note 1 is a deletion and not a respelling), and that `סגור`, the one
# unscreened word in the slang bank, does.
CARDS = [
    # ── note 1 · the verification preamble ───────────────────────────────────────────────────
    ("n1a", "n1", "אישור השם — לפני ואחרי", [
        ("A", "היום (460s בשיחה)", "רק לוודֵא — קורן, מה שם המשפחה?"),
        ("B", "אחרי השינוי — בלי הקדמה", "מה שם המשפחה שלךָ?"),
    ], []),
    ("n1b", "n1", "חזרה על הטלפון — לפני ואחרי", [
        ("A", "היום (512s בשיחה)",
         "רק לוודֵא. אפס חמש אפס, תשע שבע, שמונה שמונה שמונה, ארבע חמש?"),
        ("B", "אחרי השינוי — העריכה שלךָ",
         "חוזרת על המספר — אפס חמש אפס, תשע שבע, שמונה שמונה שמונה, ארבע חמש?"),
    ], []),
    ("n1c", "n1", "אישור השם המלא — לפני ואחרי", [
        ("A", "היום", "רק לוודֵא — קורן שטרית, נכון?"),
        ("B", "אחרי השינוי — הפרט הוא המשפט", "קורן שטרית, נכון?"),
    # deliberately UNSCORED — see roundtrip7.ts: there is no "expected" text here, the whole point
    # is to READ what comes back off A and watch the round-6 finding reproduce on this exact audio.
    ], []),

    # ── note 2 · the comma inside a two-word greeting ────────────────────────────────────────
    ("n2a", "n2", "נעים מאוד + שם — עם פסיק ובלי", [
        ("A", "היום (30s בשיחה) — עם פסיק",
         "נעים מאוד, קורן. אצלי אחלה — ספר לי קצת על העסק, במה אתה עוסק?"),
        ("B", "בלי פסיק — משפט חד",
         "נעים מאוד קורן. אצלי אחלה — ספר לי קצת על העסק, במה אתה עוסק?"),
    ], []),
    ("n2b", "n2", "נעים מאוד + שם — לבד, בלי המשך", [
        ("A", "עם פסיק", "נעים מאוד, קורן."),
        ("B", "בלי פסיק", "נעים מאוד קורן."),
    ], []),

    # ── note 3 · the mirror plus the compliment ──────────────────────────────────────────────
    ("n3a", "n3", "ציטוט המילים שלו + מחמאה", [
        ("A", "היום (44s בשיחה)",
         "בניית אתרים זה תחום מעניין. איך לקוחות חדשים מגיעים אליךָ היום — דרך המלצות, גוגל, או משהו אחר?"),
        ("B", "אחרי השינוי — ישר לשאלה",
         "איך לקוחות חדשים מגיעים אליךָ היום — דרך המלצות, גוגל, או משהו אחר?"),
    ], []),
    ("n3b", "n3", "\"וואלה? זה ממש מעניין\" על תשובה רגילה", [
        ("A", "היום (48s בשיחה)",
         "וואלה? זה ממש מעניין. כשנכנסות אליךָ הרבה פניות, מי תופס אותן בדרך כלל?"),
        ("B", "אחרי השינוי — בלי התלהבות מומצאת",
         "כשנכנסות אליךָ הרבה פניות, מי תופס אותן בדרך כלל — אתה לבד, או שיש עוד מישהו בצוות?"),
    ], []),

    # ── note 4 · two filler noises in one breath ─────────────────────────────────────────────
    ("n4a", "n4", "מילת מילוי כפולה", [
        ("A", "היום (23s בשיחה) — קבלה + היסוס",
         "אהה. רגע... בוא נבדוק מה הכי מתאים לעסק שלךָ."),
        ("B", "אחרי השינוי — סאונד אחד בנשימה",
         "אהה. בוא נבדוק מה הכי מתאים לעסק שלךָ."),
        ("C", "רק ההיסוס, בלי הקבלה",
         "רגע... בוא נבדוק מה הכי מתאים לעסק שלךָ."),
    ], []),

    # ── note 5 · THE CONTROL — what must NOT change ──────────────────────────────────────────
    ("n5a", "n5", "הבעת רגש על משהו מבאס — לשימור", [
        ("A", "היום (103s בשיחה)",
         "אוף... זה באמת מבאס. בדיוק במצבים כאלה הסוכן שלנו תופס את השיחות הראשונות ונותן מענה מיידי."),
        ("B", "אותו דבר, אחרי השינוי",
         "אוף... זה באמת מבאס. בדיוק במצבים כאלה הסוכן שלנו תופס את השיחות הראשונות ונותן מענה מיידי."),
    ], []),
    ("n5b", "n5", "סלנג בתחילת השיחה — לשימור", [
        ("A", "היום (16s בשיחה)", "בסדר. סבבה לגמרי. רק שאדע, איך קוראים לךָ?"),
        ("B", "אחרי השינוי — הסלנג נשאר, ההקדמה יורדת", "בסדר. סבבה לגמרי. איך קוראים לךָ?"),
    ], []),

    # ── note 6 · the comprehension claim ─────────────────────────────────────────────────────
    ("n6a", "n6", "\"טוב, הבנתי\" על תשובה של מילה אחת", [
        ("A", "היום (229s, אחרי \"בכלל אני לבד\")", "טוב, הבנתי. זה מסביר את העומס."),
        ("B", "אחרי השינוי — קבלה פשוטה", "אוקיי. זה מסביר את העומס."),
    ], []),
    ("n6b", "n6", "אותן מילים, על תור שבאמת סיפר משהו", [
        ("A", "הבנתי אותךָ — כשהוא באמת שיתף",
         "הבנתי אותךָ. זה באמת מתסכל כשיש עומס כזה."),
        ("B", "קבלה פשוטה באותו מקום",
         "אוקיי. זה באמת מתסכל כשיש עומס כזה."),
    ], []),

    # ── note 7 · small talk before business ──────────────────────────────────────────────────
    ("n7a", "n7", "ישר לעסק, או שתי שורות סמול טוק", [
        ("A", "היום — ישר לשאלה המקצועית",
         "נעים מאוד קורן. ספר לי קצת על העסק, במה אתה עוסק?"),
        ("B", "סמול טוק גנרי",
         "נעים מאוד קורן. איך היה היום שלךָ עד עכשיו?"),
        ("C", "סמול טוק שקשור למה שהוא אמר",
         "נעים מאוד קורן. תפסתי אותךָ באמצע משהו, או שיש לךָ דקה?"),
    ], []),

    # ── note 9 · the validating preamble before a price answer ───────────────────────────────
    ("n9a", "n9", "מחיר — עם ובלי \"מחיר זה חשוב\"", [
        ("A", "היום (281s בשיחה)",
         "בסדר. מחיר זה חשוב. את המספר המדויק קורן יסביר בשיחה עצמה, כי זה תלוי במה אתה צריך."),
        ("B", "אחרי השינוי — ישר לתשובה",
         "את המספר המדויק קורן יסביר בשיחה עצמה, כי זה תלוי במה אתה צריך ובאיך בונים את זה לעסק שלךָ."),
    ], []),

    # ── the one unscreened word in the bank ──────────────────────────────────────────────────
    ("sg1", "sg", "סגור — המילה היחידה בבנק שלא עברה סינון", [
        ("A", "סוף משפט", "אז סגור, נתראה מחר באחת."),
        ("B", "אמצע משפט", "אם זה סגור מבחינתךָ, אני קובעת את זה עכשיו."),
        ("C", "לבד", "סגור."),
    ], ["סגור"]),
]

GROUPS = [
    ("n1", "1 · \"רק לוודא\" / \"רק שאדע\" — ההקדמה לפני שאלה",
     "ההערה שלךָ: <b>״הסוכן אומר רק ׳שאדע׳ או ׳רק לוודא׳. זה נשמע לא אנושי, ועדיף פשוט בלי זה; פשוט לשאול.״</b> "
     "A בכל כרטיס הוא מה שנאמר בשיחה בפועל. ומעבר לאוזן — העברנו את שלוש ההקלטות האלה דרך קו של 8kHz "
     "ובחזרה (roundtrip7.ts): <b>בשתיים משלוש, ״רק לוודֵא״ חזר כ״רק לוועדה״</b>, ובאחת הוא שרד. "
     "כלומר זה נשבר לסירוגין — בדיוק ה״לא תמיד נכון״ שאמרת. לכן המשפט נמחק ולא אויית מחדש בפעם השלישית."),
    ("n2", "2 · הפסיק בתוך ״נעים מאוד, קורן״",
     "ההערה שלךָ: <b>״שימוש בפסיקים ונקודה ב׳נעים מאוד, כורן׳ יוצר ממש דיבור רובוטי. זה אמור לבוא ׳נעים מאוד כורן׳ "
     "במשפט חד בלי עצירות.״</b> הפסיק קונה בערך 0.18 שניות ולפעמים נעלם לגמרי — כאן שומעים אם הוא באמת מפריע."),
    ("n3", "3 · לצטט אותו בחזרה ולהחמיא",
     "ההערה שלךָ: <b>״׳בניית אתרים. תחום מעניין׳ — זה ציטוט של הרובוט, וזה נשמע ממש רובוטי, מתחנף ומוזר.״</b> "
     "המקור היה דוגמה בפרומפט עצמו (״וואלה? זה ממש מעניין״) שהמודל העתיק מילה במילה."),
    ("n4", "4 · שתי מילות מילוי בנשימה אחת",
     "ההערה שלךָ: <b>״שימוש במילות מילוי יותר מדי ובכפילות… מילת מילוי צריכה להגיע באופן חד פעמי בכל משפט.״</b> "
     "A הוא באג אמיתי בקוד: הקבלה והמילת־מילוי נכתבו על ידי שני מנגנונים שונים לאותו מקום."),
    ("n5", "5 · מה שאסור היה לקלקל — בקרה",
     "אלה שתי הנקודות שביקשת <b>לשמר</b>. A ו-B כאן הם בכוונה כמעט אותו דבר. אם הם נשמעים לךָ פחות טוב "
     "מאשר בשיחה — השינוי פגע במשהו שנאמר לו לא לגעת בו, וזה מה שהכרטיסים האלה קיימים כדי לתפוס."),
    ("n6", "6 · ״טוב, הבנתי״ — מתי זה מגיע",
     "ההערה שלךָ: <b>״צריך באמת להגיע בהקשר כשהלקוח משתף מידע שרלוונטי לשיחה. לא סתם להגיד ׳טוב, הבנתי׳ על כל דבר.״</b> "
     "המילים האלה הן שלנו, לא של המודל — הסוכן מדבר אותן בתחילת כל תור. עכשיו הן נאמרות רק אחרי תור שבאמת אמר משהו. "
     "בכרטיס הראשון תשפוט את A על תשובה של שתי מילים; בשני, על תור שבאמת סיפר משהו."),
    ("n7", "7 · סמול טוק לפני העסק",
     "ההערה שלךָ: <b>״הסוכן צריך לנהל סמול טוק קטן של משפט או שניים לפני שניגש רק למקצועיים.״</b> "
     "המתח מול הערה 3 הוא כל הקושי: סמול טוק הוא חילופי דברים, לא מחמאה על התחום שלו."),
    ("n9", "9 · ״מחיר זה חשוב״ לפני תשובה על מחיר",
     "ההערה שלךָ: <b>״זה משפט מיותר. נשמע שוב מתחנף ורובוטי.״</b> המקור היה הוראה מפורשת בפלייבוק ההתנגדויות "
     "(״הכירי בכך שתקציב חשוב״) — היא נמחקה."),
    ("sg", "בונוס · המילה סגור",
     "הוספת אותה לבנק הסלנג בעצמךָ, וכל שאר המילים בבנק עברו סינון דרך קו טלפון לפני שנכנסו — "
     "כי מילה עברית שלא נבדקה נכשלת <b>בשקט</b> (״חח״ יצא כאותיות, ״אוו״ נבלע לגמרי). "
     "העברנו גם אותה: <b>3 מתוך 3 חזרו כ״סגור״</b> דרך קו של 8kHz (roundtrip7.ts). "
     "מה שנשאר לךָ זה האוזן — האם זה נשמע כמו משהו שבן אדם אומר."),
]


def main() -> None:
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {
        "model": synthmod.MODEL,
        "generation_config": synthmod.GENERATION_CONFIG,
        "cards": [],
    }
    for cid, section, word, variants, hear in CARDS:
        card = {"id": cid, "section": section, "word": word, "hear": hear, "variants": []}
        for key, label, text in variants:
            fname = f"r7_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            # Existing clips are kept, like round 6: his ear and any later analysis must judge the
            # SAME audio. Delete a wav (or pass --resynth) to regenerate it.
            if "--resynth" in sys.argv or not os.path.exists(path):
                synth(text, path)
            card["variants"].append(
                {"key": key, "label": label, "text": text, "file": fname, "dur": round(dur(path), 2)}
            )
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(
        manifest,
        open(os.path.join(HERE, "round7.json"), "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=2,
    )
    print("wrote round7.json")
    write_page(manifest)


def variant_html(cid: str, v: dict) -> str:
    return f"""
      <div class="col">
        <div class="vhead"><span class="vkey">{v['key']}</span>
          <span class="vlabel">{htmlmod.escape(v['label'])}</span>
          <span class="tag">{v.get('dur', '?')}s</span></div>
        <div class="he" dir="rtl">{htmlmod.escape(v['text'])}</div>
        <audio controls preload="none" src="{v['file']}"></audio>
        <div class="psrow">
          <label class="lbl"><input type="radio" name="pick_{cid}" value="{v['key']}"> זה עדיף</label>
        </div>
      </div>"""


def card_html(c: dict) -> str:
    cols = "".join(variant_html(c["id"], v) for v in c["variants"])
    return f"""
    <div class="card" data-id="{c['id']}">
      <div class="chead"><span class="cid">{htmlmod.escape(c['word'])}</span>
        <span class="tag">{c['id']}</span></div>
      <div class="cols">{cols}</div>
      <div class="psrow">
        <label class="lbl none"><input type="radio" name="pick_{c['id']}" value="none"> שניהם לא טובים</label>
        <input type="text" class="note" name="note_{c['id']}" dir="rtl" placeholder="מה שמעת?">
      </div>
    </div>"""


def write_page(data: dict) -> None:
    body = []
    for key, title, sub in GROUPS:
        cards = [c for c in data["cards"] if c["section"] == key]
        if not cards:
            continue
        body.append(f'<h2>{title}</h2><p class="sub">{sub}</p>' + "".join(card_html(c) for c in cards))

    model = htmlmod.escape(data["model"])
    gc = data.get("generation_config") or {}
    gctxt = f"speed {gc.get('speed', 1)} · volume {gc.get('volume', 1)}"

    page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>סבב 7 · תשע ההערות מהשיחה של 31.8 · {model}</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2; --acc:#3b82f6; --keep:#22c55e; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header, main {{ max-width:1100px; margin:0 auto; padding:0 20px; }}
  header {{ padding-top:26px; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  h2 {{ font-size:18px; margin:34px 0 2px; }}
  .sub {{ color:var(--dim); font-size:14px; margin:4px 0 10px; line-height:1.6; }}
  .lede {{ background:#171b22; border:1px solid var(--line); border-inline-start:3px solid var(--acc);
           border-radius:10px; padding:14px 16px; margin:14px 0 6px; font-size:14px; line-height:1.65; color:#cbd3de; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:14px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:10px; }}
  .cid {{ font-weight:700; font-size:19px; }}
  .tag {{ font-size:12px; color:var(--dim); font-family:monospace; }}
  .cols {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:10px; }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col:has(input:checked) {{ border-color:var(--acc); }}
  .vhead {{ display:flex; align-items:center; gap:8px; margin-bottom:6px; }}
  .vkey {{ font-family:monospace; font-weight:700; color:var(--acc); }}
  .vlabel {{ font-size:13px; color:var(--dim); }}
  .lbl {{ font-size:13px; color:var(--dim); display:inline-flex; align-items:center; gap:6px; cursor:pointer; }}
  .none {{ color:#e0a0a0; }}
  .he {{ font-size:19px; margin-bottom:8px; line-height:1.5; }}
  audio {{ width:100%; height:34px; }}
  .psrow {{ display:flex; gap:14px; align-items:center; margin-top:10px; flex-wrap:wrap; }}
  .note {{ flex:1; min-width:220px; background:#0e1116; border:1px solid var(--line); border-radius:8px;
           color:var(--txt); padding:8px 10px; font-size:14px; }}
  #summary {{ width:100%; min-height:220px; background:#0f131a; color:var(--txt); border:1px solid var(--line);
              border-radius:10px; padding:12px; font-family:monospace; font-size:13px; direction:ltr; }}
  button {{ background:var(--acc); border:0; color:#fff; border-radius:8px; padding:10px 18px;
            font-size:14px; cursor:pointer; margin:10px 0; }}
</style>
</head>
<body>
<header>
  <h1>סבב 7 — תשע ההערות מהשיחה של 31.8 ({model}, {gctxt})</h1>
  <div class="lede">
    בכל כרטיס: <b>A זה מה ששמעת בשיחה בפועל</b> (הועתק מהתמלול, כולל הניקוד שהסוכן מוסיף לפני ההשמעה),
    ו-B זה מה שהסוכן אומר אחרי השינוי. סמן מה עדיף, ובסוף ״צור סיכום״ והדבק לי בחזרה.<br>
    ⚠️ הדף הזה בודק <b>ניסוח</b>, לא התנהגות. השאלה אם המודל באמת יפסיק לעשות את זה בשיחה אמיתית
    לא נענית פה ולא נענית באף בדיקה בקוד — רק בשיחה.
  </div>
  <p class="sub">כל ההקלטות סונתזו במהירות ובעוצמה של הפרודקשן (0.9 / 1.4), כמו בסבב 6.</p>
</header>
<main>
{''.join(body)}
<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = 'r7-verdicts';
const state = JSON.parse(localStorage.getItem(KEY) || '{{}}');
document.querySelectorAll('input').forEach(el => {{
  if (el.type === 'radio' && state[el.name] === el.value) el.checked = true;
  if (el.type === 'text' && state[el.name]) el.value = state[el.name];
  el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {{
    state[el.name] = el.value;
    localStorage.setItem(KEY, JSON.stringify(state));
  }});
}});
document.getElementById('btn').addEventListener('click', () => {{
  const lines = ['round7 verdicts ({model})'];
  document.querySelectorAll('.card').forEach(card => {{
    const id = card.dataset.id;
    const pick = state['pick_' + id] || '-';
    const note = state['note_' + id] ? '  note: ' + state['note_' + id] : '';
    lines.push(id + ': ' + pick + note);
  }});
  const box = document.getElementById('summary');
  box.value = lines.join('\\n');
  box.select();
}});
</script>
</body>
</html>"""
    open(os.path.join(HERE, "index-round7.html"), "w", encoding="utf-8").write(page)
    print("wrote index-round7.html")


if __name__ == "__main__":
    main()
