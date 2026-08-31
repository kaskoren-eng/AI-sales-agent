"""
Round 11 — the dictation nod, which round 10 could not settle, and one pair nobody has heard.

═══════════════════════════════════════════════════════════════════════════════════════════════
WHY THIS ROUND EXISTS
═══════════════════════════════════════════════════════════════════════════════════════════════

Round 10 settled nine of its ten cards. Card `n1` — the vocal nod she makes WHILE the caller is
reading out a phone number or spelling an email — got no verdict at all: `אה אה.`, `אהה.`,
`אה-אה.` and `אַה אַה.` were all rejected. So `DICTATION_NOD` is still the unscreened string a
previous session wrote down on 2026-08-30, and it is still spoken on production calls.

It is the hardest card in the set for a structural reason. **It is the only sound in the agent's
vocabulary that is spoken ALONE** — no carrier sentence in front of it or behind it to lend it
context and rhythm. Every other candidate the listening rounds have ever judged had a sentence
around it. This one is one syllable, on its own, into a caller's ear, mid-number.

So this round does not offer a fifth spelling of `אה`. It offers:

  · the two sounds Koren PICKED in round 10 — `אמ` (the new receipt) and `אֶה` (the new
    hesitation vowel) — in this position, which he has never heard them in;
  · the everyday Israeli back-channels that were never in any round: `אהם`, `אהא`, `הממ`, `אמהם`;
  · doubled forms, because a nod may need two beats where a receipt needs one;
  · pointed forms of the ones he leaned toward, since a segol won him two cards out of two.

**And "none of these" is a real answer with a real consequence.** If no sound works, the honest
conclusion is that there is no good nod and she should say NOTHING mid-dictation — which is a code
change in `chooseTurnOpener`, not a fifth guess at a spelling. The card says so.

── THE SECOND CARD, `p1` — a pair the code currently refuses on MY judgement, not his ─────────

Round 10 replaced the receipt `אהה.` with `אמ.` and the hesitation `אממ...` with `אֶממ...`. Those
are two different acts and the pairing rule (`mayPairInOneBreath`, his own round-7 rule) says a
receipt and a hesitation may share one breath. But they are now nearly the same SOUND — "אמ. אֶממ..."
is one closed-lip hum twice, which is the stutter he ruled out in round 7 wearing a new face.

I have refused that pair in code. **He has never heard it.** Card `p1` plays it against the pair
that is fine and against the receipt alone, so his ear can confirm or overturn a guard I put in on
a prediction.

═══════════════════════════════════════════════════════════════════════════════════════════════
AND AN INSTRUMENT CORRECTION — READ THIS BEFORE READING ANY TRANSCRIPT ON THIS PAGE
═══════════════════════════════════════════════════════════════════════════════════════════════

The 8kHz round trip measures ONE thing: whether Soniox can transcribe our own Cartesia output
after it has been squeezed through a phone band.

  · For a CONTENT word — an email address, a name, `לוודא`, `נוח` — that is a genuine proxy for
    intelligibility, and it has earned its keep: it caught `נוח` → `נח` and `רק לוודא` →
    `רק לוועדה`, both of which a caller really did mishear.

  · **For a filler it is close to meaningless.** Nobody needs to transcribe a hesitation. It has
    to sound right to a human ear and nothing else.

Round 10 demonstrated the limit concretely, and I passed the result on to Koren as fact when it was
not one. `אמ` was reported as "never came back from the line" on card `f3`, and the IDENTICAL
STRING came back cleanly as `אממ` on card `f1` — same word, same voice, same model, different
carrier sentence. He then chose it on `f1`, by ear, and he was right. A transcript that disagrees
with itself across two carriers cannot disqualify anything.

So on this page every transcript is printed and every transcript is labelled WEAK. Nothing is
marked red, nothing is called unusable, and no candidate is withdrawn on a machine's opinion.

═══════════════════════════════════════════════════════════════════════════════════════════════

PRODUCTION PARITY — sonic-3.5 at VOICE_TTS_SPEED=0.9 / VOICE_TTS_VOLUME=1.4, the same as rounds
6–10, and every clip's header is repaired and verified at the moment of writing, so these play.

    python tests/hebrew-tts-niqqud-ab/round11.py              # synth + write index-round11.html
    npx tsx tests/hebrew-tts-niqqud-ab/roundtrip11.ts         # 8kHz phone band -> Soniox
    python tests/hebrew-tts-niqqud-ab/round11.py              # re-run to fold the transcripts in
    python tests/hebrew-tts-niqqud-ab/round11.py --resynth    # regenerate every clip
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
from wavcheck import assert_playable

synthmod.MODEL = os.environ.get("ROUND11_MODEL", "sonic-3.5")
synthmod.GENERATION_CONFIG = {
    "speed": float(os.environ.get("ROUND11_SPEED", "0.9")),
    "volume": float(os.environ.get("ROUND11_VOLUME", "1.4")),
}

SHEVA, TSERE, SEGOL, PATACH, KAMATZ, HOLAM = "ְ", "ֵ", "ֶ", "ַ", "ָ", "ֹ"

# The carrier the pairing card is spoken in — the same sentence round 10 used, so a clip from this
# page and a clip from that one differ only in the thing being judged.
T = "בוא נבדוק מה הכי מתאים לעסק שלךָ."

CARRIER_OF_SECTION = {
    "nod": "",  # the nod is spoken ALONE — that is the whole difficulty of the card
    "pair": T,
}

# (card_id, section, what it asks, [(key, label, text)])
#
# NOTHING ON THIS PAGE IS SCORED. Both cards are about how a sound lands on a human ear, and the
# round trip has no opinion worth having about either — see the instrument correction above. The
# transcripts are printed because they are cheap and occasionally interesting; they decide nothing.
CARDS = [
    ("n1", "nod", "ההנהון באמצע הכתבת מספר — נאמר לבד", [
        ("A", "אמ — מה שבחרת ל״קבלה״ בסבב 10, בפעם הראשונה לבד", "אמ."),
        ("B", "אֶה — התנועה שבחרת ל״היסוס״ בסבב 10, לבד", f"א{SEGOL}ה."),
        ("C", "אֶמ — אמ עם הסגול שניצח פעמיים", f"א{SEGOL}מ."),
        ("D", "אמ אמ — כפול, כמו הנהון ולא כמו מילה", "אמ אמ."),
        ("E", "אֶה אֶה — ההנהון של היום, עם הסגול שלךָ", f"א{SEGOL}ה א{SEGOL}ה."),
        ("F", "אהם — ההנהון הישראלי היומיומי, לא היה באף סבב", "אהם."),
        ("G", "אֲהֶם — אותו דבר, מנוקד", f"א{PATACH}ה{SEGOL}ם."),
        ("H", "אהא", "אהא."),
        ("I", "אֲהָא — מנוקד", f"א{PATACH}ה{KAMATZ}א."),
        ("J", "הממ — הזמזום הסגור, בלי אל״ף בהתחלה", "הממ."),
        ("K", "אמהם — שני פעימות באף", "אמהם."),
        ("L", "אָה — תנועה פתוחה אחת, קמץ", f"א{KAMATZ}ה."),
    ]),

    ("p1", "pair", "אמ. + אֶממ... — שני צלילים בנשימה אחת", [
        ("A", "אמ. אֶממ... — הצמד שחסמתי בקוד", f"אמ. א{SEGOL}ממ... {T}"),
        ("B", "אמ. רֶגַע... — צמד שהקוד מרשה", f"אמ. ר{SEGOL}ג{PATACH}ע... {T}"),
        ("C", "אמ. לבד — מה שקורה היום אחרי החסימה", f"אמ. {T}"),
    ]),
]

GROUPS = [
    ("nod", "1 · ההנהון — הקליפים היחידים שנאמרים לבד",
     "כשאתה מקריא לה מספר טלפון או מאיית כתובת מייל, היא לא אמורה להגיד משפט — היא אמורה להנהן "
     "ולתת לךָ להמשיך. בסבב 10 הצעתי ארבעה איותים של <code>אה אה</code> ו<b>פסלת את כולם</b>, ולכן "
     "מה שרץ היום בפרודקשן זה עדיין הניחוש הישן.<br><br>"
     "<b>לכן כאן אין איות חמישי של אותו צליל.</b> יש כאן: שני הצלילים ש<b>אתה</b> בחרת בסבב 10 "
     "(<code>אמ</code> ו-<code>אֶה</code>) — שמעולם לא שמעת אותם לבד; ההנהונים הישראליים "
     "היומיומיים שלא היו באף סבב (<code>אהם</code>, <code>אהא</code>, <code>הממ</code>, "
     "<code>אמהם</code>); וצורות כפולות, כי הנהון אולי צריך שתי פעימות במקום אחת.<br><br>"
     "<b>זה הקושי של הכרטיס הזה:</b> כל שאר המילים שנשפטו אי־פעם נאמרו בתוך משפט. זאת המילה "
     "היחידה בכל אוצר המילים של הסוכנת שנאמרת <b>לבד</b>, בלי שום דבר מסביב שייתן לה הקשר.<br><br>"
     "⚠️ <b>״אף אחד לא טוב״ זאת תשובה אמיתית עם משמעות אמיתית.</b> אם אף צליל לא עובד, המסקנה "
     "הישרה היא שאין הנהון טוב ושהיא צריכה פשוט <b>לשתוק</b> באמצע הכתבה — וזה שינוי בקוד, לא "
     "ניחוש חמישי. אל תבחר משהו רק כדי לבחור.<br><br>"
     "📏 <b>עובדה קשה אחת על הקבצים, וזאת מדידה של האודיו עצמו ולא תמלול:</b> קליפ <b>A</b> "
     "(<code>אמ.</code> לבד) יצא <b>שקט כמעט לחלוטין</b> — 0.16 שניות, עוצמת שיא 49 מתוך 32767. "
     "קרטזיה לא הוציאה צליל למחרוזת הזאת כשהיא לבד. עם ניקוד (<b>C</b>, <code>אֶמ.</code>) ובצורה "
     "הכפולה (<b>D</b>) היא כן יוצאת חזק, ובסבב 10 היא יצאה מצוין בתוך משפט. "
     "<b>השארתי את A בעמוד כדי שתשמע את זה בעצמך</b>, ולא הורדתי אותו — אבל אין שם מה לשמוע."),

    ("pair", "2 · הצמד שחסמתי בקוד בלי ששמעת אותו",
     "בסבב 10 בחרת <code>אמ.</code> ל״קבלה״ ו-<code>אֶממ...</code> ל״היסוס״. אלה שתי פעולות שונות, "
     "והכלל שלךָ מסבב 7 אומר שקבלה והיסוס יכולים ללכת ביחד באותה נשימה "
     "(<i>״אהה ורגע יכולים להתאים ביחד״</i>). אבל אחרי סבב 10 שני הצלילים האלה כמעט זהים — "
     "<b>״אמ. אֶממ...״ זה אותו זמזום סגור פעמיים</b>, וזה בדיוק הגמגום שפסלת בסבב 7.<br><br>"
     "<b>חסמתי את הצמד הזה בקוד על סמך ניחוש שלי, ואתה לא שמעת אותו.</b> A זה הצמד החסום, B זה "
     "צמד שהקוד מרשה, C זה מה שיוצא היום אחרי החסימה. אם A נשמע בסדר — אני מוריד את החסימה."
     "<br><br>"
     "שתי הערות על התמלולים שמתחת לקליפים, ושתיהן <b>עדות חלשה</b> ולא הכרעה:<br>"
     "· ב-A המכונה כתבה <code>אממ.</code> אחד בלבד — היא לא הבחינה בין שני הצלילים. זה מרמז שהם "
     "מתמזגים, וזה בדיוק החשש. <b>האוזן שלךָ מכריעה, לא היא.</b><br>"
     "· ב-C המילה <code>אמ.</code> לא הופיעה בתמלול בכלל, וב-B אותה מילה בדיוק חזרה בתור "
     "<code>אממ</code>. <b>אותה מחרוזת, אותו קול, שני משפטים שונים, שתי תוצאות הפוכות</b> — זאת "
     "עוד הדגמה חיה למה אסור לפסול אופציה על סמך תמלול."),
]


NIQQUD_CHARS = "".join(chr(c) for c in range(0x0591, 0x05C8))
PUNCT = " .,:;?!־-…׳״\"'"


def _norm(s: str) -> str:
    """Comparison key: no niqqud, no punctuation, no spaces. Only the letters survive."""
    return "".join(ch for ch in s if ch not in PUNCT and ch not in NIQQUD_CHARS)


def split_off_carrier(heard: str, carrier: str) -> str:
    """
    What the machine wrote for the CANDIDATE, with the carrier sentence subtracted.

    Round 10's version of this returned a `survived` flag as well, and the page painted an empty
    result red and called the spelling unusable. That was overstated — see the instrument note at
    the top of this file — so the flag is gone. This returns text to READ, and nothing here decides
    anything.
    """
    if not carrier:
        return heard.strip()
    key = _norm(carrier)
    hn = _norm(heard)
    idx = hn.find(key)
    if idx <= 0:
        # Carrier missing (it came back mangled too) or nothing in front of it. Either way there is
        # no meaningful subtraction to do, so show the whole thing.
        return heard.strip()
    seen = 0
    cut = 0
    for i, ch in enumerate(heard):
        if seen >= idx:
            cut = i
            break
        if ch not in PUNCT and ch not in NIQQUD_CHARS:
            seen += 1
        cut = i + 1
    return heard[:cut].strip(PUNCT)


def load_heard() -> dict:
    """Round-trip transcripts from roundtrip11.ts, if it has been run. Absent on a first build."""
    path = os.path.join(HERE, "round11-heard.json")
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
    for cid, section, word, variants in CARDS:
        card = {
            "id": cid, "section": section, "word": word,
            # Read by roundtrip11.ts as well as by this file's page builder — one definition.
            "carrier": CARRIER_OF_SECTION.get(section, ""),
            "variants": [],
        }
        for key, label, text in variants:
            fname = f"r11_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            # Existing clips are kept, like rounds 6-10: his ear and any later analysis must judge
            # the SAME audio. Delete a wav (or pass --resynth) to regenerate it.
            if "--resynth" in sys.argv or not os.path.exists(path):
                synth(text, path)
            # Belt and braces: synth() finalizes every header it writes, and this asserts it again
            # for clips that were already on disk from an earlier run. Round 6 and round 7 were both
            # lost to unplayable files and neither run said so.
            assert_playable(path)
            variant = {
                "key": key, "label": label, "text": text, "file": fname, "dur": round(dur(path), 2)
            }
            if f"{cid}_{key}" in HEARD:
                variant["heard"] = HEARD[f"{cid}_{key}"]
            card["variants"].append(variant)
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(
        manifest,
        open(os.path.join(HERE, "round11.json"), "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=2,
    )
    print("wrote round11.json")
    write_page(manifest)


def variant_html(cid: str, v: dict, carrier: str = "") -> str:
    # What Soniox wrote down off this exact clip through an 8kHz round trip (roundtrip11.ts).
    # ONE STYLE, ONE LABEL, NO COLOURS. Round 10 painted some of these red and told Koren the
    # spelling was "unusable whatever it sounds like"; the same string then came back perfectly on
    # another card and he chose it. A transcriber has no useful opinion about a hesitation sound,
    # and a page that dresses one up as a verdict is worse than a page with no transcripts at all.
    heard = v.get("heard")
    heard_html = ""
    if heard is not None:
        word_heard = split_off_carrier(heard, carrier)
        shown = word_heard if word_heard else "(כלום)"
        heard_html = (
            f'<div class="heard" dir="rtl"><span class="hlbl">מה שהמכונה כתבה '
            f"(<b>עדות חלשה</b> — היא לא שומעת הגייה, רק מנחשת מילה):</span>"
            f'<b>{htmlmod.escape(shown)}</b>'
            f'<span class="full">— מהקליפ כולו: {htmlmod.escape(heard.strip() or "(כלום)")}</span></div>'
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
          <label class="lbl"><input type="radio" name="pick_{cid}" value="{v['key']}"> זה הכי טוב</label>
        </div>
      </div>"""


NONE_LABEL = {
    "n1": "אף אחד לא טוב — עדיף שתשתוק באמצע ההכתבה",
    "p1": "אף אחד לא טוב",
}


def card_html(c: dict) -> str:
    cols = "".join(variant_html(c["id"], v, c.get("carrier", "")) for v in c["variants"])
    last = NONE_LABEL.get(c["id"], "אף אחת לא טובה")
    return f"""
    <div class="card" data-id="{c['id']}">
      <div class="chead"><span class="cid">{htmlmod.escape(c['word'])}</span>
        <span class="tag">{c['id']}</span></div>
      <div class="cols">{cols}</div>
      <div class="psrow">
        <label class="lbl none"><input type="radio" name="pick_{c['id']}" value="none"> {last}</label>
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
<title>סבב 11 · ההנהון · {model}</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2;
           --acc:#3b82f6; --warn:#f59e0b; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header, main {{ max-width:1100px; margin:0 auto; padding:0 20px; }}
  header {{ padding-top:26px; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  h2 {{ font-size:18px; margin:34px 0 2px; }}
  .sub {{ color:var(--dim); font-size:14px; margin:4px 0 10px; line-height:1.6; }}
  .lede {{ background:#171b22; border:1px solid var(--line); border-inline-start:3px solid var(--acc);
           border-radius:10px; padding:14px 16px; margin:14px 0 6px; font-size:14px;
           line-height:1.65; color:#cbd3de; }}
  .lede.warn {{ border-inline-start-color:var(--warn); }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:14px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:10px; }}
  .cid {{ font-weight:700; font-size:19px; }}
  .tag {{ font-size:12px; color:var(--dim); font-family:monospace; }}
  .cols {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:10px; }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col:has(input:checked) {{ border-color:var(--acc); }}
  .vhead {{ display:flex; align-items:center; gap:8px; margin-bottom:6px; }}
  .vkey {{ font-family:monospace; font-weight:700; color:var(--acc); }}
  .vlabel {{ font-size:13px; color:var(--dim); }}
  .lbl {{ font-size:13px; color:var(--dim); display:inline-flex; align-items:center; gap:6px; cursor:pointer; }}
  .none {{ color:#e0a0a0; }}
  .he {{ font-size:21px; margin-bottom:8px; line-height:1.5; }}
  audio {{ width:100%; height:34px; }}
  .heard {{ margin-top:8px; font-size:13px; line-height:1.5; border-radius:8px; padding:7px 9px;
            background:#0b0e13; border:1px solid var(--line); color:var(--dim); }}
  .hlbl {{ color:var(--dim); font-size:12px; display:block; margin-bottom:2px; }}
  .full {{ color:var(--dim); font-size:12px; display:block; margin-top:3px; }}
  .psrow {{ display:flex; gap:14px; align-items:center; margin-top:10px; flex-wrap:wrap; }}
  .note {{ flex:1; min-width:220px; background:#0e1116; border:1px solid var(--line); border-radius:8px;
           color:var(--txt); padding:8px 10px; font-size:14px; }}
  #summary {{ width:100%; min-height:160px; background:#0f131a; color:var(--txt); border:1px solid var(--line);
              border-radius:10px; padding:12px; font-family:monospace; font-size:13px; direction:ltr; }}
  button {{ background:var(--acc); border:0; color:#fff; border-radius:8px; padding:10px 18px;
            font-size:14px; cursor:pointer; margin:10px 0; }}
</style>
</head>
<body>
<header>
  <h1>סבב 11 — ההנהון, והצמד שחסמתי ({model}, {gctxt})</h1>
  <div class="lede">
    בסבב 10 סגרת תשעה כרטיסים מתוך עשרה. הכרטיס שנשאר פתוח הוא <b>ההנהון</b> — הצליל שהיא עושה
    בזמן שאתה מקריא לה מספר טלפון — ופסלת שם את כל ארבע האפשרויות. לכן מה שרץ היום בפרודקשן זה
    עדיין <code>אה אה.</code>, מחרוזת שאף אחד לא בחר.<br><br>
    שני כרטיסים כאן, ושניהם קצרים: <b>ההנהון</b>, ו<b>צמד אחד שחסמתי בקוד על סמך ניחוש שלי</b>
    ואתה עוד לא שמעת. סמן, ובסוף ״צור סיכום״ והדבק לי בחזרה.
  </div>

  <div class="lede warn">
    ⚠️ <b>תיקון למכשיר המדידה — ובגלל טעות שלי, לא של המכונה.</b><br>
    בדיקת ה-8kHz בודקת דבר אחד: האם סוניוקס מצליחה לתמלל את מה שקרטזיה הוציאה, אחרי שהעברנו אותו
    דרך קו טלפון.<br><br>
    <b>למילת תוכן</b> — כתובת מייל, שם, <code>לוודא</code> — זאת בדיקה טובה, והיא זאת שתפסה
    ״נח״ במקום ״נוח״ ו״רק לוועדה״ במקום ״רק לוודא״. <b>למילת מילוי היא כמעט חסרת משמעות</b>: אף
    אחד לא צריך לתמלל היסוס. הוא רק צריך להישמע נכון לאוזן.<br><br>
    בסבב 10 דיווחתי לךָ ש-<code>אמ</code> ״לא חזרה מהקו בכלל״ בכרטיס <code>f3</code>. <b>אותה
    מחרוזת בדיוק חזרה נקי בתור <code>אממ</code> בכרטיס <code>f1</code></b> — אותה מילה, אותו קול,
    אותו דגם, רק משפט אחר סביבה. ואז בחרת אותה ב-<code>f1</code>, באוזן, וצדקת. תמלול שסותר את
    עצמו בין שני כרטיסים לא יכול לפסול כלום.<br><br>
    לכן בעמוד הזה: <b>כל תמלול מודפס, כל תמלול מסומן כעדות חלשה, שום אפשרות לא נפסלת ושום דבר
    לא צבוע באדום.</b> כל ההחלטות כאן שלךָ.
  </div>

  <p class="sub">
    כל ההקלטות סונתזו במהירות ובעוצמה של הפרודקשן (0.9 / 1.4) ובאותו דגם, והכותרת של כל קובץ
    נבדקה אחרי הכתיבה ולפני שהעמוד נכתב — <b>אין כאן קליפ שלא מתנגן</b>.
  </p>
</header>
<main>
{''.join(body)}
<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = 'r11-verdicts';
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
  const lines = ['round11 verdicts ({model})'];
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
    open(os.path.join(HERE, "index-round11.html"), "w", encoding="utf-8").write(page)
    print("wrote index-round11.html")


if __name__ == "__main__":
    main()
