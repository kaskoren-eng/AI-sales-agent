"""Generates index-de.html — focused A/D/E page for the 4 gender-suffix sentences."""
import json, html, os

HERE = os.path.dirname(os.path.abspath(__file__))
m = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))
rows = [r for r in m if r.get("de_changed")]

LISTEN = {
    "04": "‏<b>שלך</b> / <b>לך</b> — זכר (shel-KHA / le-KHA)?",
    "06": "‏<b>שלך</b> — זכר? (בתוך משפט עם CRM/דשבורד)",
    "09": "‏<b>אליך</b> — זכר (e-le-KHA)?",
    "10": "‏<b>אליך</b> — זכר? (אחרי AI)",
}

def col(label, cls, text, wav, dur, base):
    r = dur / max(base, 0.01)
    flag = " slow" if r >= 1.6 else (" fast" if r <= 0.9 else "")
    return f"""<div class="col {cls}">
          <div class="lbl">{label} <span class="dur{flag}">{dur:.2f}s ×{r:.2f}</span></div>
          <div class="he" dir="rtl">{html.escape(text)}</div>
          <audio controls preload="none" src="{wav}"></audio>
        </div>"""

cards = []
for r in rows:
    a = col("A · רגיל (גלם)", "a", r["plain"], r["file_a"], r["dur_a"], r["dur_a"])
    d = col("D · Phonikud→איות רגיל (0 ניקוד)", "d", r["text_d"], r["file_d"], r["dur_d"], r["dur_a"])
    e = col("E · ניקוד תקני מלא על המילה", "e", r["text_e"], r["file_e"], r["dur_e"], r["dur_a"])
    f = col("F · ניקוד מינימלי (תנועה אחת)", "f", r["text_f"], r["file_f"], r["dur_f"], r["dur_a"])
    cards.append(f"""
    <div class="card">
      <div class="chead"><span class="cid">{r['id']}</span><span class="ctag">{html.escape(r['tag'])}</span></div>
      <div class="listen">🎧 {LISTEN.get(r['id'],'')}</div>
      <div class="grid">{a}{d}{e}{f}</div>
      <div class="verdict">
        <span>הכי טוב?</span>
        <label><input type="radio" name="v{r['id']}" value="A"> A</label>
        <label><input type="radio" name="v{r['id']}" value="D"> D</label>
        <label><input type="radio" name="v{r['id']}" value="E"> E</label>
        <label><input type="radio" name="v{r['id']}" value="F"> F</label>
        <label><input type="radio" name="v{r['id']}" value="same"> שווה</label>
      </div>
    </div>""")

cards_html = "\n".join(cards)
idtags = json.dumps([{"id": r["id"], "tag": r["tag"]} for r in rows], ensure_ascii=False)

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phonikud כאורקל · A/D/E</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2;
          --a:#3b82f6; --d:#22c55e; --e:#f59e0b; --f:#a855f7; --warn:#f59e0b; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header {{ padding:26px 20px 12px; max-width:1180px; margin:0 auto; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  .sub {{ color:var(--dim); font-size:14px; max-width:82ch; }}
  .sub code {{ background:#0b0e13; padding:1px 5px; border-radius:4px; }}
  .sub .gp {{ color:#22c55e; }} .sub .ep {{ color:#f59e0b; }}
  main {{ max-width:1180px; margin:0 auto; padding:0 20px 90px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:16px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:8px; }}
  .cid {{ font-weight:700; background:#0b0e13; border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:13px; }}
  .ctag {{ color:var(--dim); font-size:13px; font-family:monospace; direction:ltr; }}
  .listen {{ font-size:14px; color:#cdd5e0; background:#0b0e13; border:1px dashed var(--line); border-radius:8px; padding:8px 12px; margin-bottom:12px; }}
  .listen b {{ color:#fff; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:12px; }}
  @media (max-width:980px) {{ .grid {{ grid-template-columns:1fr 1fr; }} }}
  @media (max-width:560px) {{ .grid {{ grid-template-columns:1fr; }} }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col.a {{ border-top:3px solid var(--a); }}
  .col.d {{ border-top:3px solid var(--d); }}
  .col.e {{ border-top:3px solid var(--e); }}
  .col.f {{ border-top:3px solid var(--f); }}
  .lbl {{ font-size:12.5px; color:var(--dim); margin-bottom:8px; display:flex; justify-content:space-between; gap:8px; }}
  .dur {{ font-family:monospace; color:var(--dim); }}
  .dur.slow {{ color:var(--warn); font-weight:700; }}
  .dur.fast {{ color:var(--a); font-weight:700; }}
  .he {{ font-size:20px; margin-bottom:10px; min-height:56px; }}
  audio {{ width:100%; height:34px; }}
  .verdict {{ display:flex; align-items:center; gap:16px; margin-top:12px; padding-top:12px; border-top:1px solid var(--line); font-size:14px; flex-wrap:wrap; }}
  .verdict > span {{ color:var(--dim); }} .verdict label {{ cursor:pointer; }}
  .summary {{ position:sticky; bottom:0; background:#0b0e13ee; backdrop-filter:blur(6px); border-top:1px solid var(--line); padding:12px 20px; }}
  .summary .row {{ max-width:1180px; margin:0 auto; display:flex; gap:18px; align-items:center; flex-wrap:wrap; font-size:14px; }}
  .tally b {{ font-size:16px; }}
  button {{ background:#2b6; color:#04210f; border:0; border-radius:8px; padding:8px 14px; font-weight:700; cursor:pointer; }}
  #out {{ width:100%; margin-top:8px; background:#0f131a; color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px; font-family:monospace; font-size:12px; direction:ltr; display:none; }}
</style>
</head>
<body>
<header>
  <h1>Phonikud כ<u>אורקל</u> — A / D / E / F (ניקוד תוקן)</h1>
  <p class="sub">רק 4 המשפטים עם פנייה בזכר. כולם ניקוד <b>תקין</b> עכשיו (הקמץ הסופי חזר).
  <b>A</b> = גלם. <b class="gp">D</b> = Phonikud מחליט מגדר → <b>איות רגיל, 0 ניקוד</b> (שלך→שלכה; מה שבפרודקשן היום).
  <b class="ep">E</b> = <b>ניקוד תקני מלא</b> על המילה (שֶׁלְּךָ). <b style="color:#a855f7">F</b> = <b>ניקוד מינימלי</b> —
  תנועה <b>אחת</b> בלבד על ה-כ הסופית (שלךָ), הכי פחות "רעש" ל-sonic-3.
  המבחן: איזה מהם נשמע זכרי ונקי בו-זמנית — D, E או F.</p>
</header>
<main>
{cards_html}
</main>
<div class="summary">
  <div class="row">
    <span class="tally">A: <b id="tA">0</b></span>
    <span class="tally" style="color:var(--d)">D: <b id="tD">0</b></span>
    <span class="tally" style="color:var(--e)">E: <b id="tE">0</b></span>
    <span class="tally" style="color:var(--f)">F: <b id="tF">0</b></span>
    <span class="tally">שווה: <b id="tS">0</b></span>
    <span class="tally" style="color:var(--dim)">נשאר: <b id="tN">4</b></span>
    <button onclick="dump()">הצג סיכום להעתקה</button>
  </div>
  <textarea id="out" rows="6" readonly></textarea>
</div>
<script>
  const data = {idtags};
  const KEY = 'niqqud-adef-verdicts';
  const saved = JSON.parse(localStorage.getItem(KEY) || '{{}}');
  for (const [id,v] of Object.entries(saved)) {{
    const el = document.querySelector(`input[name="v${{id}}"][value="${{v}}"]`); if (el) el.checked = true;
  }}
  function tally() {{
    let a=0,d=0,e=0,f=0,s=0,n=0;
    for (const r of data) {{
      const v = (document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value;
      if (v==='A') a++; else if (v==='D') d++; else if (v==='E') e++; else if (v==='F') f++; else if (v==='same') s++; else n++;
    }}
    tA.textContent=a; tD.textContent=d; tE.textContent=e; tF.textContent=f; tS.textContent=s; tN.textContent=n;
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
    let a=0,d=0,e=0,f=0,s=0;
    for (const r of data) {{ const v=(document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value; if(v==='A')a++;else if(v==='D')d++;else if(v==='E')e++;else if(v==='F')f++;else if(v==='same')s++; }}
    const o = document.getElementById('out'); o.style.display='block';
    o.value = lines.join('\\n') + `\\n---\\nA=${{a}}  D=${{d}}  E=${{e}}  F=${{f}}  same=${{s}}`;
    o.select();
  }}
  tally();
</script>
</body>
</html>"""

open(os.path.join(HERE, "index-de.html"), "w", encoding="utf-8").write(page)
print("wrote index-de.html")
