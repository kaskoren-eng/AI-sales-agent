"""Generates the round-6 listening page.

    python build_round6_page.py            -> index-round6.html  (round6.json)

Three kinds of card, because round 6 asks three different questions and a single ok/bad control
would blur them:

  * A/B/C pick  (fl, nd, nx, vd, ps) — several spellings or punctuations of the same sentence;
    choose the one that sounds right, or "none of them".
  * Forced GENDER choice (g, sw) — "which gender did you hear?". This is the only honest control
    for רוצה: masculine and feminine are the same letters, so "sounds fine" is not an answer and
    the round-trip is blind to it (see roundtrip6.ts).
  * The `ps` cards additionally carry MEASURED pauses under each clip (pause_probe.py), and each
    variant appears twice: one-shot (what /tts/bytes returns with the whole sentence in hand) and
    "זרימה" — the agent's own websocket stream, which is what the caller actually hears.

Verdicts are stored in localStorage and dumped as a copyable summary at the bottom.
"""
import json, html, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "round6.json"), encoding="utf-8"))

GENDER_SECTIONS = {"g", "sw"}

GROUPS = [
    ("fl", "1 · מילות מילוי — האיות שנשמע נכון",
     "הבעיה שדיווחת: \"במקום להגיד אהה הסוכן אומר אוהה או אההא\". כל וריאנט הוא אותו משפט, "
     "רק האיות של מילת המילוי משתנה. המילה נאמרת תמיד מודבקת לתחילת התשובה — לכן היא מושמעת כאן בהקשר, לא לבד."),
    ("nd", "2 · הנהון קולי — בזמן שהלקוח מכתיב מספר",
     "כשהלקוח מכתיב טלפון או מייל היא לא תגיד \"טוב, הבנתי\" אלא הנהון קצר שאומר *קיבלתי, תמשיך*. "
     "כאן נאמר לבד, כי ככה הוא יישמע בשיחה. מה שנשמע כמו מילה ולא כמו הנהון — נפסל."),
    ("g", "3 · רוצה — איזה מין נשמע?",
     "בחירה כפויה, לא תקין/לא תקין: אותן אותיות בדיוק לזכר ולנקבה, וההקלטה חזרה (Soniox) לא יכולה "
     "להבדיל ביניהן. B בכל כרטיס הוא מה שמושמע היום — הוא נוסף ב-26.8 בהיקש משלךָ ומעולם לא נבחן באוזן."),
    ("sw", "4 · אותה תקלה במילים אחרות — סריקה",
     "כל פועל בהווה מגזרת ל\"ה נכתב זהה לזכר ולנקבה (מחכה, רואה, עושה, עונה, מנסה, מקווה, נראה). "
     "טקסט רגיל, בדיוק מה שנשלח היום. רק מילה שנשמעת במין הלא נכון תקבל תיקון — לא מתקנים על סמך תיאוריה."),
    ("nx", "5 · נוח", "החשד: הפתח הגנוב — נוֹחַ זה שתי הברות (נו-אח), ובלי ניקוד זה יכול להישמע כהברה אחת."),
    ("vd", "6 · לוודא", "B הוא מה שמושמע היום (לוודֵא, מנצח סבב 3). דיווחת שזה \"לא תמיד נכון\" — הנה שני ההקשרים מהשיחה האמיתית."),
    ("ps", "7 · זרימה והפסקות",
     "לכל וריאנט שתי הקלטות: <b>בקשה אחת</b> (המשפט כולו נשלח בבת אחת) ו<b>זרימה</b> — הערוץ שהסוכן "
     "באמת מדבר דרכו בשיחה. מתחת לכל הקלטה מופיעות ההפסקות שנמדדו בפועל, במילישניות."),
]


def gaps_html(v):
    if "gaps" not in v:
        return ""
    g = v["gaps"]
    txt = " · ".join(f"{x['ms']}ms" for x in g) if g else "אין הפסקה נמדדת"
    return (f'<div class="meas">דיבור {v.get("speechMs", 0)}ms · {len(g)} הפסקות: {html.escape(txt)}</div>')


def variant_html(cid, v, gender):
    """One clip. Gender cards ask which gender you heard (per clip); the rest ask which spelling
    or punctuation wins (one pick per card, so the radios share a name)."""
    if gender:
        controls = "".join(
            f'<label class="lbl"><input type="radio" name="pick_{cid}_{v["key"]}" value="{val}">'
            f' {txt}</label>'
            for val, txt in (("m", "זכר"), ("f", "נקבה"), ("?", "לא ברור"))
        )
    else:
        controls = (
            f'<label class="lbl"><input type="radio" name="pick_{cid}" value="{v["key"]}">'
            f' זה הכי טוב</label>'
        )
    return f"""
      <div class="col">
        <div class="vhead"><span class="vkey">{v['key']}</span>
          <span class="vlabel">{html.escape(v['label'])}</span>
          <span class="tag">{v.get('dur', '?')}s</span></div>
        <div class="he" dir="rtl">{html.escape(v['text'])}</div>
        <audio controls preload="none" src="{v['file']}"></audio>
        {gaps_html(v)}
        <div class="psrow">{controls}</div>
      </div>"""


def card_html(c):
    gender = c["section"] in GENDER_SECTIONS
    cols = "".join(variant_html(c["id"], v, gender) for v in c["variants"])
    none_row = (
        ""
        if gender
        else f'<label class="lbl none"><input type="radio" name="pick_{c["id"]}" value="none">'
        f' אף אחד לא טוב</label>'
    )
    return f"""
    <div class="card" data-id="{c['id']}" data-gender="{'1' if gender else '0'}">
      <div class="chead"><span class="cid">{html.escape(c['word'])}</span>
        <span class="tag">{c['id']}</span></div>
      <div class="cols">{cols}</div>
      <div class="psrow">{none_row}
        <input type="text" class="note" name="note_{c['id']}" dir="rtl" placeholder="מה שמעת?">
      </div>
    </div>"""


body = []
for key, title, sub in GROUPS:
    cards = [c for c in data["cards"] if c["section"] == key]
    if not cards:
        continue
    body.append(f'<h2>{title}</h2><p class="sub">{sub}</p>' + "".join(card_html(c) for c in cards))

model = html.escape(data["model"])
gc = data.get("generation_config") or {}
gctxt = f"speed {gc.get('speed', 1)} · volume {gc.get('volume', 1)}"

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>סבב 6 · ההערות מהשיחות של 30.8 · {model}</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2; --acc:#3b82f6; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header, main {{ max-width:1100px; margin:0 auto; padding:0 20px; }}
  header {{ padding-top:26px; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  h2 {{ font-size:18px; margin:34px 0 2px; }}
  .sub {{ color:var(--dim); font-size:14px; margin:4px 0 10px; line-height:1.55; }}
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
  .meas {{ font-family:monospace; font-size:12px; color:var(--dim); margin:6px 0; }}
  audio {{ width:100%; height:34px; }}
  .psrow {{ display:flex; gap:14px; align-items:center; margin-top:10px; flex-wrap:wrap; }}
  .note {{ flex:1; min-width:220px; background:#0e1116; border:1px solid var(--line); border-radius:8px;
           color:var(--txt); padding:8px 10px; font-size:14px; }}
  #summary {{ width:100%; min-height:200px; background:#0f131a; color:var(--txt); border:1px solid var(--line);
              border-radius:10px; padding:12px; font-family:monospace; font-size:13px; direction:ltr; }}
  button {{ background:var(--acc); border:0; color:#fff; border-radius:8px; padding:10px 18px;
            font-size:14px; cursor:pointer; margin:10px 0; }}
</style>
</head>
<body>
<header>
  <h1>סבב 6 — שבע ההערות מהשיחות של 30.8 ({model}, {gctxt})</h1>
  <p class="sub">כל ההקלטות סונתזו במהירות ובעוצמה של הפרודקשן, לא ב-1.0 כמו בסבבים הקודמים —
     בסבב שעוסק בקצב זה בדיוק ההבדל. להאזין, לסמן, ובסוף ״צור סיכום״ ולהעתיק לצ׳אט.</p>
</header>
<main>
{''.join(body)}
<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = 'r6-verdicts';
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
  const lines = ['round6 verdicts ({model})'];
  document.querySelectorAll('.card').forEach(card => {{
    const id = card.dataset.id;
    let pick;
    if (card.dataset.gender === '1') {{
      pick = [...card.querySelectorAll('.col')].map((col, i) => {{
        const key = col.querySelector('.vkey').textContent;
        return key + '=' + (state['pick_' + id + '_' + key] || '-');
      }}).join(' ');
    }} else {{
      pick = state['pick_' + id] || '-';
    }}
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

open(os.path.join(HERE, "index-round6.html"), "w", encoding="utf-8").write(page)
print("wrote index-round6.html")
