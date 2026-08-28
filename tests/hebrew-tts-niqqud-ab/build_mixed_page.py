"""Generates index-mixed.html — A/D/G page for mixed-gender sentences."""
import json, html, os

HERE = os.path.dirname(os.path.abspath(__file__))
m = json.load(open(os.path.join(HERE, "mixed.json"), encoding="utf-8"))

def col(label, cls, text, wav, dur, base):
    r = dur / max(base, 0.01)
    flag = " slow" if r >= 1.6 else (" fast" if r <= 0.9 else "")
    return f"""<div class="col {cls}">
          <div class="lbl">{label} <span class="dur{flag}">{dur:.2f}s</span></div>
          <div class="he" dir="rtl">{html.escape(text)}</div>
          <audio controls preload="none" src="{wav}"></audio>
        </div>"""

cards = []
for r in m:
    dec = "  ·  ".join(html.escape(d) for d in r["decisions"])
    a = col("A · גלם", "a", r["plain"], r["file_a"], r["dur_a"], r["dur_a"])
    d = col("D · Phonikud→איות", "d", r["text_d"], r["file_d"], r["dur_d"], r["dur_a"])
    g = col("G · ניקוד חכם (זכר=מינ׳, נקבה=מלא)", "g", r["text_g"], r["file_g"], r["dur_g"], r["dur_a"])
    cards.append(f"""
    <div class="card">
      <div class="chead"><span class="cid">{r['id']}</span>
        <span class="ctag">Phonikud decided: {dec}</span></div>
      <div class="grid">{a}{d}{g}</div>
    </div>""")

cards_html = "\n".join(cards)

page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>מעורב זכר/נקבה · A/D/G</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2;
          --a:#3b82f6; --d:#22c55e; --g:#a855f7; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header {{ padding:26px 20px 12px; max-width:1180px; margin:0 auto; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  .sub {{ color:var(--dim); font-size:14px; max-width:84ch; }}
  .warn {{ color:#f59e0b; }}
  main {{ max-width:1180px; margin:0 auto; padding:0 20px 60px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:16px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap; }}
  .cid {{ font-weight:700; background:#0b0e13; border:1px solid var(--line); border-radius:6px; padding:2px 8px; font-size:13px; }}
  .ctag {{ color:var(--dim); font-size:12.5px; font-family:monospace; direction:ltr; }}
  .grid {{ display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; }}
  @media (max-width:860px) {{ .grid {{ grid-template-columns:1fr; }} }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col.a {{ border-top:3px solid var(--a); }}
  .col.d {{ border-top:3px solid var(--d); }}
  .col.g {{ border-top:3px solid var(--g); }}
  .lbl {{ font-size:12.5px; color:var(--dim); margin-bottom:8px; display:flex; justify-content:space-between; gap:8px; }}
  .dur {{ font-family:monospace; color:var(--dim); }}
  .he {{ font-size:19px; margin-bottom:10px; min-height:56px; line-height:1.7; }}
  audio {{ width:100%; height:34px; }}
</style>
</head>
<body>
<header>
  <h1>מעורב זכר/נקבה — האם Phonikud מחליף מגדר בתוך משפט?</h1>
  <p class="sub">כל משפט פונה לגבר ואז לאישה. שים לב ל־<b>Phonikud decided</b> בראש כל כרטיס —
  <b class="warn">הוא סימן את שתי המילים באותו מגדר בכל המשפטים</b>, ואפילו טעה: ב-m3 הוא סימן
  "אליך" כזכר אחרי "את מוזמנת" (נקבה), וב-m5 סימן "בשבילך" כנקבה עבור "דני" (גבר).
  <b>A</b> גלם · <b style="color:#22c55e">D</b> איות · <b style="color:#a855f7">G</b> ניקוד חכם.
  תשמע ותאשר: המסירה (G זכר=שלךָ) טובה, אבל ההחלטה של מי-זכר-מי-נקבה לא אמינה.</p>
</header>
<main>
{cards_html}
</main>
</body>
</html>"""

open(os.path.join(HERE, "index-mixed.html"), "w", encoding="utf-8").write(page)
print("wrote index-mixed.html")
