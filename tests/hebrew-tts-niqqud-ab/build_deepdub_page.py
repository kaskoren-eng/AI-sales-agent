"""Generates index-deepdub.html — DeepDub vs Cartesia sonic-3, same Hebrew sentences."""
import json, html, os

HERE = os.path.dirname(os.path.abspath(__file__))
rows = json.load(open(os.path.join(HERE, "deepdub.json"), encoding="utf-8"))

LISTEN = {
    "01": "קול נשי טבעי? <b>לך</b> ברור?",
    "02": "‏<b>קרן</b> ברור? <b>ClickScales</b> טבעי?",
    "03": "‏<b>קורן</b> (KOren) — נשמע שונה מ‏קרן?",
    "04": "‏אחרי <b>אדוני</b> — <b>שלך/אליך</b> יוצאים <b>בזכר</b>?",
    "05": "‏אחרי <b>גברתי</b> — <b>שלך/אליך</b> יוצאים <b>בנקבה</b>?",
    "06": "בלי רמז מגדר — איזה מגדר <b>שלך/לך</b> יוצא? עקבי?",
    "07": "הספרות ברורות וטבעיות?",
    "08": "‏<b>CRM</b> / <b>דשבורד</b> / <b>לידים</b> ברורים?",
}

cards = []
for r in rows:
    dd_dur = r.get("dd_dur", 0); ct_dur = r.get("ct_dur", 0)
    cards.append(f"""
    <div class="card">
      <div class="chead"><span class="cid">{r['id']}</span><span class="ctag">{html.escape(r['tag'])}</span></div>
      <div class="listen">🎧 {LISTEN.get(r['id'],'')}</div>
      <div class="he" dir="rtl">{html.escape(r['text'])}</div>
      <div class="grid">
        <div class="col dd">
          <div class="lbl">DeepDub · dd-etts-3.2 <span class="dur">{dd_dur:.2f}s</span></div>
          <audio controls preload="none" src="{r['file']}"></audio>
        </div>
        <div class="col ct">
          <div class="lbl">Cartesia · sonic-3 <span class="dur">{ct_dur:.2f}s</span></div>
          <audio controls preload="none" src="{r['ct_file']}"></audio>
        </div>
      </div>
      <div class="verdict">
        <span>עדיף?</span>
        <label><input type="radio" name="v{r['id']}" value="DD"> DeepDub</label>
        <label><input type="radio" name="v{r['id']}" value="CT"> Cartesia</label>
        <label><input type="radio" name="v{r['id']}" value="same"> שווה</label>
      </div>
    </div>""")

cards_html = "\n".join(cards)
idtags = json.dumps([{"id": r["id"], "tag": r["tag"]} for r in rows], ensure_ascii=False)

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DeepDub מול Cartesia</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2;
          --dd:#a855f7; --ct:#3b82f6; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header {{ padding:26px 20px 10px; max-width:1000px; margin:0 auto; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  .sub {{ color:var(--dim); font-size:14px; max-width:80ch; }}
  main {{ max-width:1000px; margin:0 auto; padding:0 20px 90px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:16px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:8px; }}
  .cid {{ font-weight:700; background:#0b0e13; border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:13px; }}
  .ctag {{ color:var(--dim); font-size:13px; font-family:monospace; direction:ltr; }}
  .listen {{ font-size:14px; color:#cdd5e0; background:#0b0e13; border:1px dashed var(--line); border-radius:8px; padding:8px 12px; margin-bottom:10px; }}
  .listen b {{ color:#fff; }}
  .he {{ font-size:21px; margin-bottom:12px; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }}
  @media (max-width:640px) {{ .grid {{ grid-template-columns:1fr; }} }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col.dd {{ border-top:3px solid var(--dd); }} .col.ct {{ border-top:3px solid var(--ct); }}
  .lbl {{ font-size:13px; color:var(--dim); margin-bottom:8px; display:flex; justify-content:space-between; }}
  .dur {{ font-family:monospace; }}
  audio {{ width:100%; height:34px; }}
  .verdict {{ display:flex; align-items:center; gap:16px; margin-top:12px; padding-top:12px; border-top:1px solid var(--line); font-size:14px; flex-wrap:wrap; }}
  .verdict > span {{ color:var(--dim); }} .verdict label {{ cursor:pointer; }}
  .summary {{ position:sticky; bottom:0; background:#0b0e13ee; backdrop-filter:blur(6px); border-top:1px solid var(--line); padding:12px 20px; }}
  .summary .row {{ max-width:1000px; margin:0 auto; display:flex; gap:18px; align-items:center; flex-wrap:wrap; font-size:14px; }}
  .tally b {{ font-size:16px; }}
  button {{ background:#2b6; color:#04210f; border:0; border-radius:8px; padding:8px 14px; font-weight:700; cursor:pointer; }}
  #out {{ width:100%; margin-top:8px; background:#0f131a; color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px; font-family:monospace; font-size:12px; direction:ltr; display:none; }}
</style>
</head>
<body>
<header>
  <h1>DeepDub מול Cartesia sonic-3 — אותם משפטים בדיוק</h1>
  <p class="sub">קול <b style="color:#a855f7">DeepDub</b> (dd-etts-3.2, he-IL, accentRatio 0.75) מול
  <b style="color:#3b82f6">Cartesia</b> sonic-3 — טקסט רגיל בלי ניקוד בשניהם.
  שאלת המפתח: האם DeepDub מטפל ב<b>מגדר</b> נכון נטיבית (04 אדוני→זכר, 05 גברתי→נקבה),
  ובאיזה קול העברית נשמעת טבעית יותר. סמן העדפה לכל משפט.</p>
</header>
<main>
{cards_html}
</main>
<div class="summary">
  <div class="row">
    <span class="tally" style="color:var(--dd)">DeepDub: <b id="tDD">0</b></span>
    <span class="tally" style="color:var(--ct)">Cartesia: <b id="tCT">0</b></span>
    <span class="tally">שווה: <b id="tS">0</b></span>
    <span class="tally" style="color:var(--dim)">נשאר: <b id="tN">8</b></span>
    <button onclick="dump()">הצג סיכום להעתקה</button>
  </div>
  <textarea id="out" rows="10" readonly></textarea>
</div>
<script>
  const data = {idtags};
  const KEY = 'deepdub-vs-cartesia';
  const saved = JSON.parse(localStorage.getItem(KEY) || '{{}}');
  for (const [id,v] of Object.entries(saved)) {{
    const el = document.querySelector(`input[name="v${{id}}"][value="${{v}}"]`); if (el) el.checked = true;
  }}
  function tally() {{
    let dd=0,ct=0,s=0,n=0;
    for (const r of data) {{
      const v = (document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value;
      if (v==='DD') dd++; else if (v==='CT') ct++; else if (v==='same') s++; else n++;
    }}
    tDD.textContent=dd; tCT.textContent=ct; tS.textContent=s; tN.textContent=n;
  }}
  document.addEventListener('change', ev => {{
    if (ev.target.name && ev.target.name.startsWith('v')) {{
      saved[ev.target.name.slice(1)] = ev.target.value;
      localStorage.setItem(KEY, JSON.stringify(saved)); tally();
    }}
  }});
  function dump() {{
    const lines = data.map(r => {{
      const v = (document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value || '-';
      return `${{r.id}} ${{r.tag}}: ${{v}}`;
    }});
    let dd=0,ct=0,s=0;
    for (const r of data) {{ const v=(document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value; if(v==='DD')dd++;else if(v==='CT')ct++;else if(v==='same')s++; }}
    const o = document.getElementById('out'); o.style.display='block';
    o.value = lines.join('\\n') + `\\n---\\nDeepDub=${{dd}}  Cartesia=${{ct}}  same=${{s}}`;
    o.select();
  }}
  tally();
</script>
</body>
</html>"""

open(os.path.join(HERE, "index-deepdub.html"), "w", encoding="utf-8").write(page)
print("wrote index-deepdub.html")
