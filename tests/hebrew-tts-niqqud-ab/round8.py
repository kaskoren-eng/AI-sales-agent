"""
Round 8 — the email address, the one field that has now cost TWO bookings.

Every card is a moment from the 2026-08-31 production call. **A is what Koren actually heard**
(copied out of `call-reports/calls-2026-08-31.md`, including the niqqud `speech-guard.ts` adds on
the way to the TTS), and **B is what the agent says after this change**. His real address is
`kaskoren@gmail.com`; she converged on `koren@gmail.com` and the call ran out — the demo had been
agreed at 450s, and the last 54 seconds went on this field. `book_meeting` was never called.

Rounds 3-6 asked "how is this word pronounced". This round asks two different questions:

  1. PHRASING (his ear, unscored) — is the Hebrew word-first read-back easier to verify than the
     Latin-letter one? That is not a question a transcriber can answer.
  2. VOCABULARY (roundtrip8.ts, SCORED) — the method introduces words the agent has never had to
     say before: `שטרודל`, `ג'ימייל נקודה קום`, and the Hebrew letter NAMES she falls back to when
     the word read-back misses (`קיי`, `איי`, `אס`). The bank's standing rule is that an unscreened
     Hebrew word fails SILENTLY — "חח" came back as spelled letters, "אוו" vanished entirely — so a
     method built on words nobody put through an 8kHz line is a method that can fail without ever
     throwing. Those cards carry `hear` fragments and roundtrip8.ts scores them.

Card e5 is the odd one out and the commercially important one: it is not a better way to ask for
the address, it is the permission to STOP asking. There is no B-is-nicer-than-A judgement to make —
A is a call that ended with nothing, B is a call that ends with a meeting.

PRODUCTION PARITY — sonic-3.5 at VOICE_TTS_SPEED=0.9 / VOICE_TTS_VOLUME=1.4, like rounds 6 and 7.

    python tests/hebrew-tts-niqqud-ab/round8.py              # synth + write index-round8.html
    python tests/hebrew-tts-niqqud-ab/round8.py --resynth    # regenerate every clip
"""
import html as htmlmod
import json
import os
import sys

# The Windows console this repo is developed on is cp1252 and every progress line here is Hebrew.
# Without this the run dies on the FIRST print — after it has already paid Cartesia for the clip.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth
from round3 import dur

synthmod.MODEL = os.environ.get("ROUND8_MODEL", "sonic-3.5")
synthmod.GENERATION_CONFIG = {
    "speed": float(os.environ.get("ROUND8_SPEED", "0.9")),
    "volume": float(os.environ.get("ROUND8_VOLUME", "1.4")),
}

# (card_id, section, what it asks, [(key, label, text)], [round-trip fragments], [scored keys])
#
# The last two fields drive roundtrip8.ts. `hear` is what an 8kHz round trip must contain; `score`
# names WHICH variants it applies to — the A clips are usually the old line, which is not supposed
# to contain the new word at all, and scoring them was a bug in the first run of this file.
CARDS = [
    # ── the ask ──────────────────────────────────────────────────────────────────────────────
    ("e1", "ask", "לבקש את המייל — הכל בבת אחת, או רק החלק שלפני השטרודל", [
        ("A", "היום — הכתובת כולה בבת אחת", "ומה כתובת המייל?"),
        ("B", "אחרי השינוי — רק החלק שלפני השטרודל, כמילה",
         "תגיד לי את החלק שלפני השטרודל, כמילה אחת."),
    ], ["שטרודל"], ["B"]),

    # ── the read-back: THE card ──────────────────────────────────────────────────────────────
    ("e2", "readback", "הקריאה החוזרת — אותיות באנגלית מול מילה בעברית", [
        ("A", "היום (549s בשיחה) — אותיות באנגלית",
         "הבנתי אותךָ. רק לוודֵא. k o r e n at gmail dot com, נכון?"),
        ("B", "אחרי השינוי — מילה בעברית",
         "לפני השטרודל — קאסקורן. ואחריו ג'ימייל נקודה קום. נכון?"),
    ], ["שטרודל"], ["B"]),
    ("e2b", "readback", "הדומיין לבד — האם ״ג'ימייל נקודה קום״ שורד את הקו", [
        ("A", "בעברית", "הדומיין הוא ג'ימייל נקודה קום, נכון?"),
        ("B", "באנגלית, כמו היום", "הדומיין הוא gmail dot com, נכון?"),
    ], ["ג'ימייל", "גימייל", "gmail"], ["A", "B"]),

    # ── the competing-options line ───────────────────────────────────────────────────────────
    ("e3", "stitch", "אותיות שהגיעו בכמה תורות — שתי גרסאות או כתובת אחת", [
        ("A", "היום (581s בשיחה) — מגלגלת אליו את העבודה",
         "כרגע שמעתי גם k a f וגם k o r e n, ואני רוצָה לרשום את זה נכון."),
        ("B", "אחרי השינוי — חיברה אותן לפי הסדר",
         "לפני השטרודל — קאסקורן. נכון?"),
    ], [], []),

    # ── the fallback spelling, if the word read-back misses ──────────────────────────────────
    #
    # NOTE for whoever extends this: the Hebrew letter name for E is `אי`, and for A it is `איי`.
    # The first cut of this card used `איי` for both and the round trip duly returned
    # "K-A-S-K-O-R-A-N" — the instrument caught the author's spelling mistake, not a TTS defect.
    ("e4", "letters", "אם המילה לא נכונה — שמות אותיות בעברית מול אנגלית", [
        ("A", "אותיות באנגלית, כמו היום", "אז זה k. a. s. k. o. r. e. n?"),
        ("B", "שמות האותיות בעברית", "אז זה קיי. איי. אס. קיי. או. אר. אי. אן?"),
    ], [], []),

    # ── the give-up: not phrasing, permission ────────────────────────────────────────────────
    ("e5", "giveup", "אחרי שתי קריאות שנכשלו — להמשיך לנסות, או לסגור את הפגישה", [
        ("A", "היום — עוד סיבוב על אותו שדה, והשיחה נגמרה בלי פגישה",
         "אני רוצָה לוודא שרשמתי נכון. תוכל בבקשה לאיית לי את זה שוב, אות אות?"),
        ("B", "אחרי השינוי — משחררת את השדה ושומרת על הפגישה",
         "יש לי את הנייד שלךָ וזה מספיק — הצוות יחזור אליך עם הפרטים."),
    ], [], []),

    # ── the invented transliteration the whole method rests on ───────────────────────────────
    #
    # The first round trip of e2_B came back as "לפני השטרודל. ואחריו gmail.com" — `קאסקורן`
    # VANISHED. That is the silent-failure shape round 4b documented ("אוו" swallowed whole), and
    # this method asks her to say a word like it on every single email collection. Three carriers,
    # screened the way `סגור` was screened in round 7, so the finding is not one clip's accident.
    ("e6", "word", "קאסקורן — המילה הממוציאה שהשיטה כולה נשענת עליה", [
        ("A", "לבד", "קאסקורן."),
        ("B", "סוף משפט", "אז החלק שלפני השטרודל הוא קאסקורן."),
        ("C", "עם השם האמיתי שהוא נתן", "קורן שטרית — קאסקורן, נכון?"),
    ], ["קאסקורן", "קסקורן", "kaskoren"], ["A", "B", "C"]),
]

GROUPS = [
    ("ask", "1 · איך מבקשים כתובת מייל בטלפון",
     "כתובת מייל היא הפרט היחיד שקו של 8kHz פשוט הורס. השינוי מפצל את הבקשה: קודם רק החלק שלפני "
     "השטרודל, כמילה אחת — הדומיין הוא שאלה נפרדת, ורק אם הוא לא נאמר כבר. "
     "המילה <b>שטרודל</b> נכנסת כאן לראשונה לאוצר המילים של הסוכנת, ולכן היא עברה את אותו סינון "
     "טלפוני שכל מילה חדשה עוברת (roundtrip8.ts)."),
    ("readback", "2 · הקריאה החוזרת — הכרטיס המרכזי",
     "זה מה שהפיל את השיחה. A הוא מה שהיא אמרה ב-549 שניות: <b>״k o r e n at gmail dot com״</b> — "
     "אותיות באנגלית בתוך משפט בעברית, בקו טלפון. זה הדבר הכי קשה שיש לאמת, וזו הכתובת הלא נכונה. "
     "B אומר את אותו דבר כמילה עברית אחת. אם B לא ברור לךָ יותר מ-A — כל השיטה הזאת שגויה, "
     "ועדיף שתגיד את זה עכשיו.<br><br>"
     "<b>ומדידה שמושכת דווקא לכיוון השני, ואני אומר אותה כי היא נמדדה:</b> כשמעבירים את שתי "
     "ההקלטות דרך קו 8kHz ובחזרה, <b>האותיות באנגלית שורדות טוב יותר</b> מהמילה העברית — "
     "״K-O-R-E-N״ חזר שלם, ו״קאסקורן״ חזר שבור או נעלם (ראה סעיף 6 למטה). "
     "אבל המכונה שומעת עברית ולא יודעת מה השם שלךָ; אתה שומע את השם של עצמךָ ומצפה לו. "
     "ומעל הכל — האותיות מעולם לא נכשלו בהגייה, הן נכשלו <b>באימות</b>: הן הפילו שתי פגישות. "
     "לכן ההכרעה כאן היא האוזן שלךָ, לא המספר."),
    ("stitch", "3 · אותיות שהגיעו בכמה תורות",
     "הקו חותך איות לכמה תורות: ״K-A״, אחר כך ״S״, אחר כך ״K-O-R-E-N״ — זו כתובת אחת, לא שלוש "
     "גרסאות. A הוא ציטוט מדויק מהשיחה, והוא מעביר אליו את העבודה שלה. "
     "החצי הקודי כבר עלה ל-main (email-dictation.ts מחבר את האותיות לפי הסדר); "
     "מה שמתווסף כאן הוא ההוראה בפרומפט, כי הקוד יכול לזכור אותיות אבל לא יכול לקבוע מה היא תגיד."),
    ("letters", "4 · אם המילה לא נכונה — איך מאייתים",
     "רק אם הוא אומר שהמילה שגויה. השאלה: שמות אותיות באנגלית או בעברית. "
     "<b>אף אחת מהאפשרויות לא נבדקה מעולם בקו טלפון עד עכשיו</b> — והמדידה כאן לא מחמיאה לעברית: "
     "״קיי״ חזר כ״הכי״, והאות הראשונה נבלעה. באנגלית חזרו כל האותיות, עם T אחת מומצאת באמצע. "
     "<b>זו הנקודה הכי סבירה שבה טעיתי בשינוי הזה</b>, והיא שורה אחת לשנות אם האוזן שלךָ מסכימה "
     "עם המדידה."),
    ("giveup", "5 · הנקודה שעולה כסף — מתי מפסיקים לשאול",
     "זה לא כרטיס ניסוח. <b>הדמו כבר סוכם ב-450 שניות של השיחה</b>, והשיחה נגמרה ב-602 בלי פגישה, "
     "אחרי 54 שניות על השדה הזה — <code>book_meeting</code> לא נקרא אפילו פעם אחת. "
     "אחרי השינוי מותר לה לוותר על המייל ולקבוע את הפגישה בלעדיו (הכלי עצמו שונה, לא רק הטקסט). "
     "<b>שים לב למה ש-B לא מבטיח:</b> היא לא אומרת שתשלח וואטסאפ. בדקנו — ללקוח שרק התקשר אלינו "
     "אין חלון וואטסאפ פתוח, ובלי תבנית מאושרת ההודעה נחסמת בשקט. אז היא מבטיחה את הצוות, וזה נכון."),
    ("word", "6 · המילה הממוציאה עצמה — קאסקורן",
     "השיטה כולה מבקשת ממנה להגיד מילה עברית שלא קיימת: התעתיק של החלק שלפני השטרודל. "
     "בדקנו אותה בשלושה נשאים, בדיוק כמו שבדקנו את ״סגור״ בסבב 7. "
     "<b>התוצאה: אף אחד מהשלושה לא חזר שלם.</b> לבד — נבלע לגמרי (״אז קורן״). בסוף משפט — חזר "
     "כשתי מילים (״קס קורן״). אחרי השם האמיתי — <b>נעלם בלי זכר</b>. "
     "זו בדיוק צורת הכישלון השקטה שסבב 4b תיעד (״אוו״ נבלע). "
     "חשוב מה זה כן אומר ומה לא: המכונה מתמללת <b>אותה</b>, ובשיחה אמיתית אף אחד לא מתמלל אותה — "
     "מתמללים את הלקוח. אז זו עדות לכך שהמילה חלשה אקוסטית בקו, לא הוכחה שאדם לא יבין אותה. "
     "האוזן שלךָ היא מה שיכריע."),
]


def load_heard() -> dict:
    """Round-trip transcripts from roundtrip8.ts, if it has been run. Absent on a first build."""
    path = os.path.join(HERE, "round8-heard.json")
    if not os.path.exists(path):
        return {}
    return json.load(open(path, encoding="utf-8"))


HEARD = load_heard()


def main() -> None:
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    print(f"round-trip transcripts: {len(HEARD)}")
    manifest = {
        "model": synthmod.MODEL,
        "generation_config": synthmod.GENERATION_CONFIG,
        "cards": [],
    }
    for cid, section, word, variants, hear, score in CARDS:
        card = {"id": cid, "section": section, "word": word, "hear": hear, "score": score, "variants": []}
        for key, label, text in variants:
            fname = f"r8_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            # Existing clips are kept, like rounds 6 and 7: his ear and any later analysis must
            # judge the SAME audio. Delete a wav (or pass --resynth) to regenerate it.
            if "--resynth" in sys.argv or not os.path.exists(path):
                synth(text, path)
            variant = {
                "key": key, "label": label, "text": text, "file": fname, "dur": round(dur(path), 2)
            }
            # Folded in if roundtrip8.ts has already run. Re-running this script after it costs
            # nothing (the wavs are kept) and rebuilds the page with the transcripts in place.
            if f"{cid}_{key}" in HEARD:
                variant["heard"] = HEARD[f"{cid}_{key}"]
            card["variants"].append(variant)
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(
        manifest,
        open(os.path.join(HERE, "round8.json"), "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=2,
    )
    print("wrote round8.json")
    write_page(manifest)


def variant_html(cid: str, v: dict) -> str:
    # What Soniox got back off this exact clip after an 8kHz round trip (roundtrip8.ts). Shown
    # UNDER the audio on purpose: it is a second opinion, not the verdict. The machine has a Hebrew
    # language model and no idea what the caller's name is; the caller has the opposite. Where the
    # two disagree, the ear wins — but Koren should at least see where they disagree.
    heard = v.get("heard")
    heard_html = ""
    if heard:
        same = heard.strip().strip(".,:?") == v["text"].strip().strip(".,:?")
        cls = "heard same" if same else "heard diff"
        heard_html = (
            f'<div class="{cls}" dir="rtl"><span class="hlbl">מה שהמכונה שמעה דרך קו 8kHz:</span> '
            f'{htmlmod.escape(heard)}</div>'
        )
    return f"""
      <div class="col">
        <div class="vhead"><span class="vkey">{v['key']}</span>
          <span class="vlabel">{htmlmod.escape(v['label'])}</span>
          <span class="tag">{v.get('dur', '?')}s</span></div>
        <div class="he" dir="rtl">{htmlmod.escape(v['text'])}</div>
        <audio controls preload="none" src="{v['file']}"></audio>
        {heard_html}
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
<title>סבב 8 · כתובת המייל · {model}</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2; --acc:#3b82f6; --warn:#f59e0b; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header, main {{ max-width:1100px; margin:0 auto; padding:0 20px; }}
  header {{ padding-top:26px; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  h2 {{ font-size:18px; margin:34px 0 2px; }}
  .sub {{ color:var(--dim); font-size:14px; margin:4px 0 10px; line-height:1.6; }}
  .lede {{ background:#171b22; border:1px solid var(--line); border-inline-start:3px solid var(--acc);
           border-radius:10px; padding:14px 16px; margin:14px 0 6px; font-size:14px; line-height:1.65; color:#cbd3de; }}
  .lede.warn {{ border-inline-start-color:var(--warn); }}
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
  .heard {{ margin-top:8px; font-size:13px; line-height:1.5; border-radius:8px; padding:7px 9px;
            background:#0b0e13; border:1px solid var(--line); }}
  .heard.same {{ color:#8fb99a; }}
  .heard.diff {{ color:#e6b980; border-color:#4a3a22; }}
  .hlbl {{ color:var(--dim); font-size:12px; display:block; margin-bottom:2px; }}
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
  <h1>סבב 8 — כתובת המייל ({model}, {gctxt})</h1>
  <div class="lede">
    השדה הזה עלה לנו <b>שתי פגישות</b>. בשיחה של 31.8 סיכמת דמו בדקה השביעית, ואז 54 השניות
    האחרונות של השיחה הלכו על כתובת מייל אחת — הכתובת שלךָ היא <code dir="ltr">kaskoren@gmail.com</code>,
    היא התכנסה ל-<code dir="ltr">koren@gmail.com</code>, והשיחה נגמרה <b>בלי פגישה בכלל</b>.<br>
    בכל כרטיס: <b>A זה מה שנאמר בשיחה בפועל</b>, ו-B זה מה שהסוכנת אומרת אחרי השינוי.
    סמן מה עדיף, ובסוף ״צור סיכום״ והדבק לי בחזרה.
  </div>
  <div class="lede warn">
    ⚠️ הדף הזה בודק <b>ניסוח</b>. השאלה אם המודל באמת יעשה את זה בשיחה אמיתית — ובעיקר אם הוא באמת
    יוותר על השדה בכרטיס 5 במקום להמשיך לשאול — לא נענית פה, ולא נענית באף בדיקה בקוד. רק בשיחה.
  </div>
  <p class="sub">כל ההקלטות סונתזו במהירות ובעוצמה של הפרודקשן (0.9 / 1.4), כמו בסבבים 6 ו-7.</p>
</header>
<main>
{''.join(body)}
<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = 'r8-verdicts';
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
  const lines = ['round8 verdicts ({model})'];
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
    open(os.path.join(HERE, "index-round8.html"), "w", encoding="utf-8").write(page)
    print("wrote index-round8.html")


if __name__ == "__main__":
    main()
