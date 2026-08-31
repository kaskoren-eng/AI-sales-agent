"""
Round 9 — the four things Koren has NOT yet heard, after his round-7 and round-8 verdicts.

Rounds 7 and 8 asked "is B better than A?" and he answered. Nine of those answers reversed
something we had shipped, and the reversals produced NEW wording that has never been through a
phone line. This round is only that wording. Nothing here is a re-litigation of a card he has
already settled.

  e2c  The read-back he CHOSE, with the preamble he separately deleted taken off the front. He
       endorsed the English letters on card e2 — but the clip he endorsed still carried
       "הבנתי אותךָ. רק לוודֵא." in front of them, because that is how it was said on the call.
       This is the sentence as she will actually say it now.
  e3c  Card e3 got NO verdict — he rejected neither variant, which means both were wrong. A here
       is the line from the call that he had already banned; B and C are two new forms. The one
       thing neither old variant gave him is a way to CHECK the address without arbitrating
       between two readings, so B states how many letters there are.
  w1   His own amendment to card e5: after two or three failed attempts she should ask HIM to send
       the address over WhatsApp. Verified against the code before it was written — an inbound
       message opens the 24h window by itself, so this direction needs no approved template, which
       is exactly why our outbound one is still blocked. The question here is the WORDING: does she
       read a phone number out loud, or make the offer without one?
  n7b  He picked the situational small-talk opener on card n7a. He heard ONE of the three the
       prompt now offers. These are the other two.

PRODUCTION PARITY — sonic-3.5 at VOICE_TTS_SPEED=0.9 / VOICE_TTS_VOLUME=1.4, like rounds 6-8.

⚠️ THE HEADERS ARE FIXED IN THIS ROUND. Every clip in rounds 1-8 was written with 0xFFFFFFFF in
both WAV size fields — the streaming placeholder Cartesia's /tts/bytes response carries, because
its output is a stream and it cannot seek back to patch the length. Browsers disagree about such a
file and Koren could not play round 7 at all. `synth()` now repairs and then VERIFIES every clip
at the moment of writing (wavcheck.py), so these play.

    python tests/hebrew-tts-niqqud-ab/round9.py              # synth + write index-round9.html
    python tests/hebrew-tts-niqqud-ab/round9.py --resynth    # regenerate every clip
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

synthmod.MODEL = os.environ.get("ROUND9_MODEL", "sonic-3.5")
synthmod.GENERATION_CONFIG = {
    "speed": float(os.environ.get("ROUND9_SPEED", "0.9")),
    "volume": float(os.environ.get("ROUND9_VOLUME", "1.4")),
}

# (card_id, section, what it asks, [(key, label, text)], [round-trip fragments], [scored keys])
#
# The last two fields drive roundtrip9.ts. `hear` is what an 8kHz round trip must contain; `score`
# names WHICH variants it applies to — the A clips are usually the old line, which is not supposed
# to contain the new word at all, and scoring them was a bug in the first run of this file.
CARDS = [
    # ── the read-back he chose, with the preamble finally off it ─────────────────────────────
    ("e2c", "readback", "הקריאה החוזרת שבחרת — בלי ההקדמה שביקשת למחוק", [
        ("A", "הקליפ שאישרת בסבב 8 — עדיין עם ההקדמה",
         "הבנתי אותךָ. רק לוודֵא. k o r e n at gmail dot com, נכון?"),
        ("B", "אותו דבר, כמו שהיא תגיד את זה עכשיו",
         "k o r e n at gmail dot com, נכון?"),
    ], [], []),

    # ── the card that got no verdict ─────────────────────────────────────────────────────────
    ("e3c", "stitch", "אותיות שהגיעו בכמה תורות — שתי הצעות חדשות", [
        ("A", "הקו מהשיחה (581s) — פסלת אותו כבר",
         "כרגע שמעתי גם k a f וגם k o r e n, ואני רוצָה לרשום את זה נכון."),
        ("B", "חדש — קוראת חזרה כתובת אחת, ואומרת כמה אותיות",
         "זה שמונה אותיות: k. a. s. k. o. r. e. n. נכון?"),
        ("C", "חדש — כתובת אחת, בלי לספור",
         "אז החלק שלפני השטרודל הוא k. a. s. k. o. r. e. n. נכון?"),
    ], [], []),

    # ── his own amendment to e5 ──────────────────────────────────────────────────────────────
    ("w1", "whatsapp", "לבקש ממנו לשלוח את הכתובת בוואטסאפ — הניסוח", [
        ("A", "מה שהיא אומרת היום — בלי הצעה בכלל",
         "יש לי את הנייד שלךָ וזה מספיק — הצוות יחזור אליך עם הפרטים."),
        ("B", "עם המספר, מוקרא בקול",
         "אם נוח לךָ, תשלח לי אותה בוואטסאפ לאפס שלוש, שבע שש, שמונה חמש, ארבע ארבע. "
         "ואם לא — יש לי את הנייד שלךָ וזה מספיק."),
        ("C", "בלי מספר — רק ההצעה",
         "אם נוח לךָ, תשלח לי אותה בוואטסאפ. ואם לא — יש לי את הנייד שלךָ וזה מספיק."),
    ], [], []),

    # ── the other two situational openers ────────────────────────────────────────────────────
    ("n7b", "smalltalk", "שיחת חולין — שתי הפתיחות שלא שמעת", [
        ("A", "מה שבחרת בסבב 7 — לשם השוואה",
         "נעים מאוד קורן. תפסתי אותךָ באמצע משהו, או שיש לךָ דקה?"),
        ("B", "חדש", "נעים מאוד קורן. תפסתי אותךָ בזמן טוב?"),
        ("C", "חדש", "נעים מאוד קורן. יום עמוס אצלךָ היום?"),
    ], [], []),
]

GROUPS = [
    ("readback", "1 · הקריאה החוזרת, בלי ההקדמה",
     "בסבב 8 בחרת את האותיות באנגלית (כרטיס e2) — אבל הקליפ שאישרת עדיין פתח ב״הבנתי אותךָ. "
     "רק לוודֵא.״, כי ככה זה נאמר בשיחה. את ההקדמה הזאת ביקשת למחוק בנפרד, והיא נמחקה מכל מקום "
     "בפרומפט. <b>B הוא המשפט כמו שהיא באמת תגיד אותו עכשיו.</b> אם B נשמע לךָ פחות ברור מ-A, "
     "זה אומר שההקדמה עשתה עבודה שלא שמנו לב אליה, וכדאי לדעת את זה לפני שזה עולה לאוויר."),
    ("stitch", "2 · הכרטיס שלא הכרעת בו (e3)",
     "לא בחרת אף אחת מהשתיים, אז שתיהן נפסלו. A כאן הוא הציטוט מהשיחה — היא גלגלה אליךָ את "
     "העבודה — והוא כבר אסור בפרומפט. <b>מה שחסר בשתי הגרסאות הקודמות זו דרך שלךָ לבדוק אותה</b> "
     "בלי שהיא תבקש ממךָ להכריע בין שתי קריאות. ב-B היא אומרת כמה אותיות היא ספרה, כך שאם הקו "
     "בלע אות אחת — אתה שומע את זה מיד. C היא אותה כתובת בלי הספירה.<br><br>"
     "החצי הקודי כבר עובד ולא משתנה: <code>email-dictation.ts</code> מחבר את האותיות לפי הסדר "
     "שבו אמרת אותן. השאלה כאן היא רק <b>מה היא אומרת על זה בקול</b>."),
    ("whatsapp", "3 · ההערה שלךָ — שתבקש ממנו וואטסאפ",
     "כתבת: ״עדיף שהיא תבקש ממנו לשלוח לה את הכתובת אימייל בוואטצאפ אם זה לא עובד אחרי פעמיים "
     "שלוש״. <b>בדקתי בקוד לפני שכתבתי את זה, וזה עובד — בכיוון הזה בלבד.</b> הודעה שהוא שולח "
     "אלינו פותחת בעצמה את חלון 24 השעות, ולכן היא לא צריכה תבנית מאושרת. הודעה שאנחנו שולחים "
     "אליו כן צריכה, והתבנית עדיין לא אושרה — בדיוק בגלל זה היא לא מבטיחה לשלוח כלום.<br><br>"
     "<b>מה שעדיין לא סגור זה שהוא צריך לדעת לאן לכתוב.</b> המספר היחיד שקיים במערכת הוא "
     "<code>TWILIO_WHATSAPP_NUMBER</code>, הוא אופציונלי, ואין הגדרה של מספר וואטסאפ פר-לקוח. "
     "אם אין מספר מוגדר — היא לא מציעה כלום ואומרת רק את A, וזה נכון. "
     "השאלה כאן: <b>B מקריא מספר טלפון בקול באמצע שיחה. זה נשמע סביר, או מסורבל?</b> "
     "(המספר ב-B הוא דמה. לא מספר אמיתי.)"),
    ("smalltalk", "4 · שתי הפתיחות האחרות",
     "בכרטיס n7a בחרת ״תפסתי אותךָ באמצע משהו, או שיש לךָ דקה?״ ופסלת את ״איך היה היום שלךָ״. "
     "הפרומפט מציע עכשיו שלוש פתיחות מהסוג שבחרת — שמעת אחת מהן. אלה השתיים האחרות. "
     "<b>A כאן היא הבחירה שלךָ, רק לשם השוואה.</b> אם אחת מהחדשות נשמעת רע, היא יורדת."),
]

def load_heard() -> dict:
    """Round-trip transcripts from roundtrip9.ts, if it has been run. Absent on a first build."""
    path = os.path.join(HERE, "round9-heard.json")
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
            fname = f"r9_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            # Existing clips are kept, like rounds 6 and 7: his ear and any later analysis must
            # judge the SAME audio. Delete a wav (or pass --resynth) to regenerate it.
            if "--resynth" in sys.argv or not os.path.exists(path):
                synth(text, path)
            variant = {
                "key": key, "label": label, "text": text, "file": fname, "dur": round(dur(path), 2)
            }
            # Folded in if roundtrip9.ts has already run. Re-running this script after it costs
            # nothing (the wavs are kept) and rebuilds the page with the transcripts in place.
            if f"{cid}_{key}" in HEARD:
                variant["heard"] = HEARD[f"{cid}_{key}"]
            card["variants"].append(variant)
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(
        manifest,
        open(os.path.join(HERE, "round9.json"), "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=2,
    )
    print("wrote round9.json")
    write_page(manifest)


def variant_html(cid: str, v: dict) -> str:
    # What Soniox got back off this exact clip after an 8kHz round trip (roundtrip9.ts). Shown
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
<title>סבב 9 · כתובת המייל · {model}</title>
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
  <h1>סבב 9 — כתובת המייל ({model}, {gctxt})</h1>
  <div class="lede">
    הסבב הזה הוא <b>רק מה שעוד לא שמעת</b>. הערכת סבב 7 ו-8 והפכת תשע החלטות שלנו — ומההיפוך
    הזה נולד ניסוח חדש שמעולם לא עבר קו טלפון. שום כרטיס פה לא מבקש ממךָ להכריע שוב במשהו
    שכבר הכרעת.<br>
    בכרטיס <code>e3c</code> לא בחרת אף אפשרות בסבב הקודם, אז שתיהן נפסלו ויש כאן שתי הצעות חדשות.
    בכרטיס <code>w1</code> זה הניסוח של ההערה שלךָ עצמךָ.
    סמן מה עדיף, ובסוף ״צור סיכום״ והדבק לי בחזרה.
  </div>
  <div class="lede warn">
    ⚠️ <b>ההקלטות בסבב הזה אמורות סוף-סוף להתנגן.</b> כל קליפ בכל הסבבים עד עכשיו נכתב עם כותרת
    WAV שבורה — קרטזיה מחזירה סטרים ולכן כותבת מציין מקום במקום את האורך האמיתי, ואנחנו כתבנו את
    זה לדיסק כמו שהוא. חלק מהדפדפנים ניגנו את זה, חלק ניגנו רעש, וחלק פשוט סירבו. זה תוקן במקום
    שבו הקבצים נוצרים, וכל קליפ נבדק אחרי הכתיבה. אם משהו כאן עדיין לא מתנגן — תגיד מיד, זה באג
    אחר.
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
const KEY = 'r9-verdicts';
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
  const lines = ['round9 verdicts ({model})'];
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
    open(os.path.join(HERE, "index-round9.html"), "w", encoding="utf-8").write(page)
    print("wrote index-round9.html")


if __name__ == "__main__":
    main()
