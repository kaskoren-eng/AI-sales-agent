"""Generates the round-3 listening pages (self-scoring, localStorage tally).

    python build_round3_page.py                       -> index-round3.html  (round3.json)
    python build_round3_page.py round3b.json index-round3b.html
"""
import json, html, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = sys.argv[1] if len(sys.argv) > 1 else "round3.json"
OUT = sys.argv[2] if len(sys.argv) > 2 else "index-round3.html"
data = json.load(open(os.path.join(HERE, MANIFEST), encoding="utf-8"))

SECTIONS = [
    ("vd", "לוודא — הא׳ שנבלעת", "המבחן: באיזו גרסה שומעים ‏\"לְוַדֵא\" מלא, עם התנועה בסוף?"),
    ("m",  "לך / שלך — זכר", "A זה מה שרץ בהפקה היום. המבחן: מה נשמע הכי טבעי ותמיד זכר?"),
    ("f",  "לך / שלך — נקבה", "מועמדים לטבלה הנקבית (עוד לא קיימת בהפקה). המבחן: מה נשמע תמיד נקבה ונקי?"),
    ("ps", "סריקת פ / ש", "לא A/B — הקלטה אחת לכל משפט. סמן רק אם מילה נשמעת לא נכון, וכתוב איזו."),
]

def ab_card(c):
    cols = []
    for v in c["variants"]:
        cols.append(f"""
        <div class="col">
          <label class="lbl"><input type="radio" name="pick_{c['id']}" value="{v['key']}">
            <b>{v['key']}</b> · {html.escape(v['label'])} <span class="dur">{v['dur']:.2f}s</span></label>
          <div class="he" dir="rtl">{html.escape(v['text'])}</div>
          <audio controls preload="none" src="{v['file']}"></audio>
        </div>""")
    return f"""
    <div class="card" data-id="{c['id']}">
      <div class="chead"><span class="cid">{html.escape(c['word'])}</span>
        <span class="tag">{c['id']}</span></div>
      <div class="grid g{len(cols)}">{''.join(cols)}</div>
    </div>"""

def ps_card(c):
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
          <input type="text" class="note" name="note_{c['id']}" dir="rtl" placeholder="איזו מילה ומה שמעת?">
        </div>
      </div>
    </div>"""

body = []
for key, title, sub in SECTIONS:
    cards = [c for c in data["cards"] if c["section"] == key]
    if not cards:
        continue
    render = ps_card if key == "ps" else ab_card
    body.append(f'<h2>{title}</h2><p class="sub">{sub}</p>' + "".join(render(c) for c in cards))

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>סבב 3 · ליטוש הגייה · {html.escape(data['model'])}</title>
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
  .grid {{ display:grid; gap:12px; }} .g3 {{ grid-template-columns:1fr 1fr 1fr; }}
  @media (max-width:820px) {{ .g3 {{ grid-template-columns:1fr; }} }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col:has(input:checked) {{ border-color:var(--acc); }}
  .lbl {{ font-size:13px; color:var(--dim); display:flex; align-items:center; gap:6px; margin-bottom:8px; cursor:pointer; }}
  .dur {{ font-family:monospace; margin-inline-start:auto; }}
  .he {{ font-size:21px; margin-bottom:10px; }}
  audio {{ width:100%; height:34px; }}
  .psrow {{ display:flex; gap:16px; align-items:center; margin-top:10px; flex-wrap:wrap; }}
  .psrow .lbl {{ margin:0; }}
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
  <h1>סבב 3 — ליטוש הגייה ({html.escape(data['model'])})</h1>
  <p class="sub">לכל כרטיס: להאזין ולסמן. הבחירות נשמרות בדפדפן. בסוף — "סיכום" ולהעתיק לצ׳אט.</p>
</header>
<main>
{''.join(body)}
<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = 'r3-verdicts';
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
  const lines = ['round3 verdicts ({html.escape(data['model'])})'];
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

open(os.path.join(HERE, OUT), "w", encoding="utf-8").write(page)
print(f"wrote {OUT}")
