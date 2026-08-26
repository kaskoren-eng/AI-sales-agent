"""Generates index-blind.html — a BLIND A/B of DeepDub vs Cartesia. Labels hidden until reveal."""
import json, os, random, html

HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(HERE, "q_sentences.json"), encoding="utf-8"))

# Deterministic per build so the reveal mapping is stable. Randomly assign which engine is side A.
random.seed(20260717)
layout = {}  # id -> {'A': 'dd'|'ct', 'B': ...}
for r in rows:
    a_is_dd = random.random() < 0.5
    layout[r["id"]] = {"A": "dd" if a_is_dd else "ct", "B": "ct" if a_is_dd else "dd"}

def wav(engine, id):
    return f"{engine}_q{id}.wav"

cards = []
for r in rows:
    lay = layout[r["id"]]
    a_src = wav(lay["A"], r["id"])
    b_src = wav(lay["B"], r["id"])
    cards.append(f"""
    <div class="card" data-id="{r['id']}">
      <div class="chead"><span class="cid">{r['id']}</span><span class="ctag">{html.escape(r['tag'])}</span></div>
      <div class="he" dir="rtl">{html.escape(r['text'])}</div>
      <div class="grid">
        <div class="col a">
          <div class="lbl">אודיו א׳ <span class="reveal" data-id="{r['id']}" data-side="A"></span></div>
          <audio controls preload="none" src="{a_src}"></audio>
        </div>
        <div class="col b">
          <div class="lbl">אודיו ב׳ <span class="reveal" data-id="{r['id']}" data-side="B"></span></div>
          <audio controls preload="none" src="{b_src}"></audio>
        </div>
      </div>
      <div class="verdict">
        <span>איזה נשמע יותר טוב?</span>
        <label><input type="radio" name="v{r['id']}" value="A"> א׳</label>
        <label><input type="radio" name="v{r['id']}" value="B"> ב׳</label>
        <label><input type="radio" name="v{r['id']}" value="same"> שווה</label>
      </div>
    </div>""")

cards_html = "\n".join(cards)
layout_json = json.dumps(layout, ensure_ascii=False)
meta_json = json.dumps([{"id": r["id"], "tag": r["tag"]} for r in rows], ensure_ascii=False)

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>מבחן עיוור · DeepDub מול Cartesia</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2;
          --a:#3b82f6; --b:#f59e0b; --dd:#a855f7; --ct:#3b82f6; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header {{ padding:26px 20px 10px; max-width:1000px; margin:0 auto; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  .sub {{ color:var(--dim); font-size:14px; max-width:82ch; }}
  main {{ max-width:1000px; margin:0 auto; padding:0 20px 120px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:16px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:8px; }}
  .cid {{ font-weight:700; background:#0b0e13; border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:13px; }}
  .ctag {{ color:var(--dim); font-size:13px; font-family:monospace; direction:ltr; }}
  .he {{ font-size:20px; margin-bottom:12px; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }}
  @media (max-width:640px) {{ .grid {{ grid-template-columns:1fr; }} }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; border-top:3px solid #444; }}
  .lbl {{ font-size:14px; color:var(--dim); margin-bottom:8px; display:flex; gap:8px; align-items:center; }}
  .reveal {{ font-size:12px; font-weight:700; padding:1px 8px; border-radius:20px; }}
  .reveal.dd {{ background:#3a1c5c; color:#d3a5ff; }}
  .reveal.ct {{ background:#12233f; color:#7ab3ff; }}
  audio {{ width:100%; height:34px; }}
  .verdict {{ display:flex; align-items:center; gap:16px; margin-top:12px; padding-top:12px; border-top:1px solid var(--line); font-size:14px; flex-wrap:wrap; }}
  .verdict > span {{ color:var(--dim); }} .verdict label {{ cursor:pointer; }}
  .bar {{ position:sticky; bottom:0; background:#0b0e13ee; backdrop-filter:blur(6px); border-top:1px solid var(--line); padding:12px 20px; }}
  .bar .row {{ max-width:1000px; margin:0 auto; display:flex; gap:16px; align-items:center; flex-wrap:wrap; font-size:14px; }}
  .tally b {{ font-size:16px; }}
  button {{ background:#2b6; color:#04210f; border:0; border-radius:8px; padding:8px 14px; font-weight:700; cursor:pointer; }}
  button.ghost {{ background:transparent; color:var(--dim); border:1px solid var(--line); }}
  #result {{ width:100%; margin-top:8px; background:#0f131a; color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px; font-family:monospace; font-size:12px; direction:ltr; display:none; }}
  .hint {{ color:var(--dim); font-size:12.5px; }}
</style>
</head>
<body>
<header>
  <h1>מבחן עיוור — שני מנועי TTS על המשפטים של קרן</h1>
  <p class="sub">כל משפט מושמע פעמיים: <b>אודיו א׳</b> ו-<b>אודיו ב׳</b>. <b>לא כתוב מי מי</b>, והצד אקראי בכל משפט.
  תשמע ותבחר מה נשמע יותר טבעי/נכון (מגדר, שמות, אנגלית). כשתסיים — לחץ <b>"חשוף מי מי"</b> לראות את התוצאה.
  <span class="hint">שים לב לפנייה בזכר (אליך/שלך), לשמות קרן/קורן, ולמילים האנגליות CRM/onboarding.</span></p>
</header>
<main>
{cards_html}
</main>
<div class="bar">
  <div class="row">
    <span class="tally">א׳: <b id="tA">0</b></span>
    <span class="tally">ב׳: <b id="tB">0</b></span>
    <span class="tally">שווה: <b id="tS">0</b></span>
    <span class="tally" style="color:var(--dim)">נשאר: <b id="tN">{len(rows)}</b></span>
    <button id="revealBtn" onclick="reveal()">חשוף מי מי</button>
    <button class="ghost" onclick="dump()">סיכום להעתקה</button>
    <span id="score" style="font-weight:700"></span>
  </div>
  <textarea id="result" rows="8" readonly></textarea>
</div>
<script>
  const LAYOUT = {layout_json};
  const META = {meta_json};
  const KEY = 'blind-dd-ct';
  const NAME = {{ dd: 'DeepDub', ct: 'Cartesia' }};
  const saved = JSON.parse(localStorage.getItem(KEY) || '{{}}');
  for (const [id,v] of Object.entries(saved)) {{
    const el = document.querySelector(`input[name="v${{id}}"][value="${{v}}"]`); if (el) el.checked = true;
  }}
  function tally() {{
    let a=0,b=0,s=0,n=0;
    for (const r of META) {{
      const v = (document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value;
      if (v==='A') a++; else if (v==='B') b++; else if (v==='same') s++; else n++;
    }}
    tA.textContent=a; tB.textContent=b; tS.textContent=s; tN.textContent=n;
  }}
  document.addEventListener('change', ev => {{
    if (ev.target.name && ev.target.name.startsWith('v')) {{
      saved[ev.target.name.slice(1)] = ev.target.value;
      localStorage.setItem(KEY, JSON.stringify(saved)); tally();
    }}
  }});
  function engineChosen(id) {{
    const v = (document.querySelector(`input[name="v${{id}}"]:checked`)||{{}}).value;
    if (v==='A') return LAYOUT[id].A;
    if (v==='B') return LAYOUT[id].B;
    return v; // 'same' or undefined
  }}
  function reveal() {{
    document.querySelectorAll('.reveal').forEach(el => {{
      const eng = LAYOUT[el.dataset.id][el.dataset.side];
      el.textContent = NAME[eng]; el.classList.add(eng);
    }});
    let dd=0, ct=0, same=0;
    for (const r of META) {{ const e=engineChosen(r.id); if(e==='dd')dd++; else if(e==='ct')ct++; else if(e==='same')same++; }}
    document.getElementById('score').textContent = `DeepDub ${{dd}} · Cartesia ${{ct}} · שווה ${{same}}`;
    document.getElementById('revealBtn').textContent = 'נחשף';
  }}
  function dump() {{
    let dd=0,ct=0,same=0; const lines=[];
    for (const r of META) {{ const e=engineChosen(r.id);
      lines.push(`${{r.id}} ${{r.tag}}: ${{e==='dd'?'DeepDub':e==='ct'?'Cartesia':(e||'-')}}`);
      if(e==='dd')dd++; else if(e==='ct')ct++; else if(e==='same')same++; }}
    const o=document.getElementById('result'); o.style.display='block';
    o.value = lines.join('\\n') + `\\n---\\nDeepDub=${{dd}}  Cartesia=${{ct}}  same=${{same}}`;
    o.select();
  }}
  tally();
</script>
</body>
</html>"""

open(os.path.join(HERE, "index-blind.html"), "w", encoding="utf-8").write(page)
print("wrote index-blind.html")
