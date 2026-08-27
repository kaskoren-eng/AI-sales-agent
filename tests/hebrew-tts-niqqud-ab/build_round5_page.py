"""Generates the round-5 listening page — ok/bad screening per clip (round-4b style).

    python build_round5_page.py            -> index-round5.html  (round5.json)

Round 5 screens the spoken-number word forms (speech-numbers.he.ts) and the SPOKEN_REGISTER
slang candidates. Not an A/B: one clip per card; mark ok / בעיה and note what you heard.
"""
import json, html, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "round5.json"), encoding="utf-8"))

GROUPS = [
    ("t",  "שעות בדיבור — הצורות הנקביות", "המבחן: השעה נשמעת טבעית ונכונה? (ארבע וחצי, רבע לחמש, עשר וחמישה...)"),
    ("p",  "מספר טלפון — ספרה-ספרה", "המבחן: הספרות ברורות, ההפסקות בין הקבוצות נשמעות?"),
    ("pr", "מחיר", "המבחן: הסכום נשמע נכון וטבעי?"),
    ("si", "מספרים קטנים", "המבחן: המין הדקדוקי נכון (חמש דקות, שלושה ימים)?"),
    ("s",  "סלנג קל — מועמדים ל-SPOKEN_REGISTER", "המבחן: נשמע טבעי ורגוע? מילה שנשמעת מוזר — נפסלת מהבנק."),
]

def card(c):
    v = c["variants"][0]
    return f"""
    <div class="card" data-id="{c['id']}">
      <div class="chead"><span class="cid">{html.escape(c['word'])}</span>
        <span class="tag">{c['id']}</span></div>
      <div class="col">
        <div class="he" dir="rtl">{html.escape(v['text'])}</div>
        <audio controls preload="none" src="{v['file']}"></audio>
        <div class="psrow">
          <label class="lbl"><input type="radio" name="pick_{c['id']}" value="ok"> תקין</label>
          <label class="lbl"><input type="radio" name="pick_{c['id']}" value="bad"> יש בעיה</label>
          <input type="text" class="note" name="note_{c['id']}" dir="rtl" placeholder="מה שמעת?">
        </div>
      </div>
    </div>"""

def gid(cid):
    return "".join(ch for ch in cid if not ch.isdigit())

body = []
for key, title, sub in GROUPS:
    cards = [c for c in data["cards"] if gid(c["id"]) == key]
    if not cards:
        continue
    body.append(f'<h2>{title}</h2><p class="sub">{sub}</p>' + "".join(card(c) for c in cards))

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>סבב 5 · מספרים בדיבור + סלנג · {html.escape(data['model'])}</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2; --acc:#3b82f6; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header, main {{ max-width:1050px; margin:0 auto; padding:0 20px; }}
  header {{ padding-top:26px; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  h2 {{ font-size:18px; margin:30px 0 2px; }}
  .sub {{ color:var(--dim); font-size:14px; margin:4px 0 10px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:14px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:10px; }}
  .cid {{ font-weight:700; font-size:19px; }}
  .tag {{ font-size:12px; color:var(--dim); font-family:monospace; }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col:has(input:checked) {{ border-color:var(--acc); }}
  .lbl {{ font-size:13px; color:var(--dim); display:flex; align-items:center; gap:6px; cursor:pointer; }}
  .he {{ font-size:21px; margin-bottom:10px; }}
  audio {{ width:100%; height:34px; }}
  .psrow {{ display:flex; gap:16px; align-items:center; margin-top:10px; flex-wrap:wrap; }}
  .note {{ flex:1; min-width:220px; background:#0e1116; border:1px solid var(--line); border-radius:8px;
           color:var(--txt); padding:8px 10px; font-size:14px; }}
  #summary {{ width:100%; min-height:130px; background:#0f131a; color:var(--txt); border:1px solid var(--line);
              border-radius:10px; padding:12px; font-family:monospace; font-size:13px; direction:ltr; }}
  button {{ background:var(--acc); border:0; color:#fff; border-radius:8px; padding:10px 18px;
            font-size:14px; cursor:pointer; margin:10px 0; }}
</style>
</head>
<body>
<header>
  <h1>סבב 5 — מספרים בדיבור + סלנג קל ({html.escape(data['model'])})</h1>
  <p class="sub">לכל כרטיס: להאזין ולסמן. הבחירות נשמרות בדפדפן. בסוף — "סיכום" ולהעתיק לצ׳אט.</p>
</header>
<main>
{''.join(body)}
<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = 'r5-verdicts';
const state = JSON.parse(localStorage.getItem(KEY) || '{{}}');
document.querySelectorAll('input').forEach(el => {{
  if (el.type === 'radio' && state[el.name] === el.value) el.checked = true;
  if (el.type === 'text' && state[el.name]) el.value = state[el.name];
  el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {{
    state[el.name] = el.type === 'text' ? el.value : el.value;
    localStorage.setItem(KEY, JSON.stringify(state));
  }});
}});
document.getElementById('btn').addEventListener('click', () => {{
  const lines = ['round5 verdicts ({html.escape(data['model'])})'];
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

open(os.path.join(HERE, "index-round5.html"), "w", encoding="utf-8").write(page)
print("wrote index-round5.html")
