"""Generates index.html — self-contained A/B/C listening page (no fetch, works over file://)."""
import json, html, os

HERE = os.path.dirname(os.path.abspath(__file__))
m = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))

LISTEN = {
    "01": "השם <b>קרן</b> ברור? <b>ClickScales</b> טבעי?",
    "02": "<b>קורן</b> (המייסד) נשמע שונה מ‏קרן? <b>ClickScales</b>?",
    "03": "הספרות <b>אפס חמש אפס...</b> ברורות?",
    "04": "‏<b>שלך</b> / <b>לך</b> בזכר (shel-KHA / le-KHA)? — באג המגדר",
    "05": "‏<b>onboarding</b> טבעי בתוך המשפט?",
    "06": "‏<b>CRM</b> / <b>דשבורד</b> / <b>לידים</b> ברורים?",
    "07": "‏<b>שלושים דקות</b> ברור? (A היה ארוך/מגומגם)",
    "08": "‏<b>קורן שטרית</b> — השם המלא ברור?",
    "09": "‏<b>אליך</b> בזכר (e-le-KHA)? — באג המגדר",
    "10": "‏<b>AI</b> טבעי? <b>אליך</b> בזכר?",
}

def col(variant, label, cls, text, wav, dur, base=None):
    ratio = ""
    if base:
        r = dur / max(base, 0.01)
        flag = " slow" if r >= 1.6 else (" fast" if r <= 0.9 else "")
        ratio = f'<span class="dur{flag}">{dur:.2f}s ×{r:.2f}</span>'
    else:
        ratio = f'<span class="dur">{dur:.2f}s</span>'
    return f"""<div class="col {cls}">
          <div class="lbl">{label} {ratio}</div>
          <div class="he" dir="rtl">{html.escape(text)}</div>
          <audio controls preload="none" src="{wav}"></audio>
        </div>"""

cards = []
for r in m:
    a = col("A", "A · רגיל (היום)", "a", r["plain"], r["file_a"], r["dur_a"])
    b = col("B", "B · Phonikud מלא", "b", r["niqqud_clean"], r["file_b"], r["dur_b"], r["dur_a"])
    c = col("C", "C · ניקוד תקני נקי", "c", r.get("niqqud_std", ""), r["file_c"], r["dur_c"], r["dur_a"])
    cards.append(f"""
    <div class="card">
      <div class="chead"><span class="cid">{r['id']}</span><span class="ctag">{html.escape(r['tag'])}</span></div>
      <div class="listen">🎧 {LISTEN.get(r['id'],'')}</div>
      <div class="grid">{a}{b}{c}</div>
      <div class="verdict">
        <span>הכי טוב?</span>
        <label><input type="radio" name="v{r['id']}" value="A"> A</label>
        <label><input type="radio" name="v{r['id']}" value="B"> B</label>
        <label><input type="radio" name="v{r['id']}" value="C"> C</label>
        <label><input type="radio" name="v{r['id']}" value="same"> שווה</label>
      </div>
    </div>""")

cards_html = "\n".join(cards)
idtags = json.dumps([{"id": r["id"], "tag": r["tag"]} for r in m], ensure_ascii=False)

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cartesia sonic-3 · A/B/C ניקוד</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2;
          --a:#3b82f6; --b:#ef4444; --c:#22c55e; --warn:#f59e0b; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header {{ padding:26px 20px 12px; max-width:1180px; margin:0 auto; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  .sub {{ color:var(--dim); font-size:14px; max-width:80ch; }}
  .sub code {{ background:#0b0e13; padding:1px 5px; border-radius:4px; }}
  .sub .rp {{ color:#ef4444; }} .sub .gp {{ color:#22c55e; }}
  main {{ max-width:1180px; margin:0 auto; padding:0 20px 90px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:16px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:8px; }}
  .cid {{ font-weight:700; background:#0b0e13; border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:13px; }}
  .ctag {{ color:var(--dim); font-size:13px; font-family:monospace; direction:ltr; }}
  .listen {{ font-size:14px; color:#cdd5e0; background:#0b0e13; border:1px dashed var(--line); border-radius:8px; padding:8px 12px; margin-bottom:12px; }}
  .listen b {{ color:#fff; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }}
  @media (max-width:840px) {{ .grid {{ grid-template-columns:1fr; }} }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col.a {{ border-top:3px solid var(--a); }}
  .col.b {{ border-top:3px solid var(--b); }}
  .col.c {{ border-top:3px solid var(--c); }}
  .lbl {{ font-size:13px; color:var(--dim); margin-bottom:8px; display:flex; justify-content:space-between; gap:8px; }}
  .dur {{ font-family:monospace; color:var(--dim); }}
  .dur.slow {{ color:var(--warn); font-weight:700; }}
  .dur.fast {{ color:var(--a); font-weight:700; }}
  .he {{ font-size:20px; margin-bottom:10px; min-height:60px; }}
  audio {{ width:100%; height:34px; }}
  .verdict {{ display:flex; align-items:center; gap:16px; margin-top:12px; padding-top:12px; border-top:1px solid var(--line); font-size:14px; flex-wrap:wrap; }}
  .verdict > span {{ color:var(--dim); }}
  .verdict label {{ cursor:pointer; }}
  .summary {{ position:sticky; bottom:0; background:#0b0e13ee; backdrop-filter:blur(6px); border-top:1px solid var(--line); padding:12px 20px; }}
  .summary .row {{ max-width:1180px; margin:0 auto; display:flex; gap:18px; align-items:center; flex-wrap:wrap; font-size:14px; }}
  .tally b {{ font-size:16px; }}
  button {{ background:#2b6; color:#04210f; border:0; border-radius:8px; padding:8px 14px; font-weight:700; cursor:pointer; }}
  #out {{ width:100%; margin-top:8px; background:#0f131a; color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:8px; font-family:monospace; font-size:12px; direction:ltr; display:none; }}
</style>
</head>
<body>
<header>
  <h1>ניסוי ניקוד — Cartesia sonic-3 · שלוש גרסאות</h1>
  <p class="sub"><b>A</b> = הטקסט הרגיל שהסוכן שולח היום.
  <b class="rp">B</b> = פלט Phonikud מלא (כולל סימני הטעמה OLE + METEG — כנראה מה שהשמיע רע).
  <b class="gp">C</b> = ניקוד תקני נקי בלבד (הסרנו OLE/METEG/<code>|</code>, נשארו רק תנועות ודגש).
  סמן לכל משפט מה הכי טוב. ×N = כמה ארוך יותר מ-A.</p>
</header>
<main>
{cards_html}
</main>
<div class="summary">
  <div class="row">
    <span class="tally">A: <b id="tA">0</b></span>
    <span class="tally" style="color:var(--b)">B: <b id="tB">0</b></span>
    <span class="tally" style="color:var(--c)">C: <b id="tC">0</b></span>
    <span class="tally">שווה: <b id="tS">0</b></span>
    <span class="tally" style="color:var(--dim)">נשאר: <b id="tN">10</b></span>
    <button onclick="dump()">הצג סיכום להעתקה</button>
  </div>
  <textarea id="out" rows="5" readonly></textarea>
</div>
<script>
  const data = {idtags};
  const KEY = 'niqqud-abc-verdicts';
  const saved = JSON.parse(localStorage.getItem(KEY) || '{{}}');
  for (const [id,v] of Object.entries(saved)) {{
    const el = document.querySelector(`input[name="v${{id}}"][value="${{v}}"]`);
    if (el) el.checked = true;
  }}
  function tally() {{
    let a=0,b=0,c=0,s=0,n=0;
    for (const r of data) {{
      const v = (document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value;
      if (v==='A') a++; else if (v==='B') b++; else if (v==='C') c++; else if (v==='same') s++; else n++;
    }}
    tA.textContent=a; tB.textContent=b; tC.textContent=c; tS.textContent=s; tN.textContent=n;
  }}
  document.addEventListener('change', e => {{
    if (e.target.name && e.target.name.startsWith('v')) {{
      saved[e.target.name.slice(1)] = e.target.value;
      localStorage.setItem(KEY, JSON.stringify(saved));
      tally();
    }}
  }});
  function dump() {{
    const lines = data.map(r => {{
      const v = (document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value || '-';
      return `${{r.id}} ${{r.tag}}: ${{v}}`;
    }});
    let a=0,b=0,c=0,s=0;
    for (const r of data) {{ const v=(document.querySelector(`input[name="v${{r.id}}"]:checked`)||{{}}).value; if(v==='A')a++;else if(v==='B')b++;else if(v==='C')c++;else if(v==='same')s++; }}
    const o = document.getElementById('out'); o.style.display='block';
    o.value = lines.join('\\n') + `\\n---\\nA=${{a}}  B=${{b}}  C=${{c}}  same=${{s}}`;
    o.select();
  }}
  tally();
</script>
</body>
</html>"""

open(os.path.join(HERE, "index.html"), "w", encoding="utf-8").write(page)
print("wrote index.html (3 columns)")
