"""
Builds the round-22 engine-decision page — ONE self-contained HTML file, base64 audio.

Same skeleton and palette as rounds 18/21 (house system from CLAUDE.md). Round 22 specifics:
  - the pick question is "מי נשמעת יותר אנושית?" — per card, radio A/B(/C).
  - each card shows the measured warm TTFB of the DeepDub line next to Cartesia's ~217ms bench,
    because the engine decision is latency as much as sound.
  - a facts strip up top lists what a switch re-opens, so the verdict is made with the bill
    visible.

    python tests/hebrew-tts-niqqud-ab/build_round22_page.py
"""
import base64, html, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "round22.json"), encoding="utf-8"))
e = html.escape

parts = ["""<title>סבב 22 — שאלת המנוע</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>
:root{
  --ground:#f6f7f9; --card:#ffffff; --line:#dfe3ea; --line-soft:#eaedf2;
  --ink:#131722; --mut:#666e80; --accent:#4a55c7; --accent-soft:#eceefb;
  --warn:#a34a1c; --warn-soft:#fbefe8;
  --sans:'Heebo',system-ui,'Segoe UI',Arial,sans-serif;
  --mono:'IBM Plex Mono',ui-monospace,'Cascadia Mono',Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --ground:#0d1016; --card:#151a23; --line:#262d3a; --line-soft:#1d232e;
    --ink:#e6e9ef; --mut:#8d95a6; --accent:#8e97f5; --accent-soft:#1c2035;
    --warn:#e0915f; --warn-soft:#2a1f18;
  }
}
:root[data-theme="dark"]{
  --ground:#0d1016; --card:#151a23; --line:#262d3a; --line-soft:#1d232e;
  --ink:#e6e9ef; --mut:#8d95a6; --accent:#8e97f5; --accent-soft:#1c2035;
  --warn:#e0915f; --warn-soft:#2a1f18;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.65 var(--sans)}
.wrap{max-width:34rem;margin:0 auto;padding:24px 16px 140px}
header{margin-bottom:22px}
h1{font-size:25px;line-height:1.25;font-weight:700;margin:0 0 10px;text-wrap:balance}
.lede{color:var(--mut);font-size:15px;margin:0}
.lede b{color:var(--ink);font-weight:500}
.facts{border:1px solid var(--warn);background:var(--warn-soft);border-radius:12px;
       padding:12px 14px;margin-top:16px;font-size:14px;color:var(--ink)}
.facts b{color:var(--warn)}
.facts ul{margin:6px 0 0;padding-inline-start:18px}
.rule{height:1px;background:var(--line);margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.chead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
h2{font-size:17px;font-weight:700;margin:0;flex:1 1 auto}
.len{font:600 12px/1 var(--mono);color:var(--accent);background:var(--accent-soft);
     border-radius:999px;padding:5px 9px;white-space:nowrap}
.note{color:var(--mut);font-size:14px;margin:0 0 14px}
.opt{border:1px solid var(--line-soft);border-radius:10px;padding:12px;margin-bottom:10px;
     background:var(--ground)}
.opt:last-of-type{margin-bottom:0}
.otop{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.key{font:600 12px/1 var(--mono);color:var(--mut);border:1px solid var(--line);
     border-radius:5px;padding:4px 7px}
.delta{font:400 12px/1 var(--mono);color:var(--mut);margin-inline-start:auto}
.txt{font-size:15px;margin:0 0 10px}
audio{width:100%;height:38px;display:block}
.pick{display:flex;align-items:center;gap:10px;margin-top:10px;padding:11px 10px;
      border:1px solid var(--line);border-radius:8px;cursor:pointer;font-size:15px;
      background:var(--card);min-height:46px}
.pick input{width:20px;height:20px;accent-color:var(--accent);margin:0}
.pick:has(input:checked){border-color:var(--accent);background:var(--accent-soft);font-weight:500}
.pick:focus-within{outline:2px solid var(--accent);outline-offset:2px}
.bar{position:fixed;inset-inline:0;bottom:0;background:var(--card);border-top:1px solid var(--line);
     padding:12px 16px calc(12px + env(safe-area-inset-bottom));display:flex;gap:10px;
     justify-content:center}
button{font:600 15px var(--sans);border:0;border-radius:9px;padding:13px 20px;cursor:pointer;
       background:var(--accent);color:#fff;min-height:46px}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
#out{font:400 13px/1.7 var(--mono);background:var(--card);border:1px solid var(--line);
     border-radius:10px;padding:14px;white-space:pre-wrap;margin-top:16px;display:none;
     overflow-x:auto}
#out.on{display:block}
@media (prefers-reduced-motion:no-preference){.pick{transition:border-color .12s,background .12s}}
</style>
<div class="wrap">
<header>
<h1>שאלת המנוע: קרטסיה או DeepDub</h1>
<p class="lede">אותם משפטים, מהפרומפט החי, פס טלפון 8kHz. <b>A = קרטסיה כמו היום</b>
(‏0.9/1.4)‏. <b>B = DeepDub דרך הקוד שלנו</b> — בדיוק מה שפרודקשן היה אומר אחרי החלפת דגל
אחד. בכרטיס המחיר גם C — הזוכה היחיד של סבב 21.<br><br>
DeepDub כבר ניצח פעם 6:1 בעיוור (יולי) והשארנו את קרטסיה. עכשיו יש סיבה חדשה — הוא נושם
לבד. תשמע ותכריע.</p>
<div class="facts" dir="rtl"><b>מה מעבר ל-DeepDub פותח מחדש:</b>
<ul>
<li>‏TTFB חם שנמדד היום: ‏336–502ms מול ‎~217ms של קרטסיה (בתקציב, אבל איטי יותר).</li>
<li>אין כפתור מהירות/עוצמה ב-adapter — היום היא מדברת ב-0.9 על קרטסיה.</li>
<li>תיקוני הניקוד (שלךָ, לוודֵא) כוילו באוזן על קרטסיה — צריך האזנה מחדש.</li>
<li>פיצ'ר הפאוזות ‎&lt;break&gt; הוא SSML של קרטסיה.</li>
<li>עלות לדקה — עוד לא נבדקה מול ‎₪0.29/דקה הנוכחי.</li>
</ul></div>
</header>
<div class="rule"></div>
"""]


def b64(path):
    raw = open(os.path.join(HERE, path), "rb").read()
    return "data:audio/wav;base64," + base64.b64encode(raw).decode("ascii")


for card in data["cards"]:
    cid = card["id"]
    parts.append('<section class="card" dir="rtl">')
    ttfb = card.get("ttfb_dd")
    badge = f"DD ‏{ttfb}ms · CT ‎~217ms" if ttfb else "A/B"
    parts.append(
        f'<div class="chead"><h2>{e(card["title"])}</h2>'
        f'<span class="len">{e(badge)}</span></div>'
    )
    parts.append(f'<p class="note">{e(card["note"])}</p>')
    for v in card["variants"]:
        parts.append(
            f'<div class="opt"><div class="otop"><span class="key">{v["key"]}</span>'
            f'<span class="delta">{v["ms"]} ms</span></div>'
            f'<p class="txt">{e(v["label"])}</p>'
            f'<audio controls preload="none" src="{b64(v["file"])}"></audio>'
            f'<label class="pick"><input type="radio" name="p_{cid}" value="{v["key"]}">'
            f'זו נשמעת יותר אנושית</label></div>'
        )
    parts.append(
        f'<label class="pick"><input type="radio" name="p_{cid}" value="-">'
        f'אין הבדל שמשנה</label>'
    )
    parts.append("</section>")

ids = [c["id"] for c in data["cards"]]
parts.append(f"""</div>
<div class="bar">
  <button onclick="summarise()">צור סיכום</button>
  <button class="ghost" onclick="copyOut()">העתק</button>
</div>
<pre id="out" dir="ltr"></pre>
<script>
const IDS = {json.dumps(ids)};
function summarise(){{
  let t = 'round22 verdicts (cartesia sonic-3.5 vs deepdub dd-etts-3.2, phone band)\\n';
  for (const id of IDS) {{
    const el = document.querySelector('input[name="p_' + id + '"]:checked');
    t += id + ': ' + (el ? el.value : '(no answer)') + '\\n';
  }}
  const out = document.getElementById('out');
  out.textContent = t;
  out.classList.add('on');
  out.scrollIntoView({{behavior: 'smooth', block: 'end'}});
}}
async function copyOut(){{
  const out = document.getElementById('out');
  if (!out.classList.contains('on')) summarise();
  try {{
    await navigator.clipboard.writeText(out.textContent);
    const b = document.querySelectorAll('.bar button')[1];
    const was = b.textContent; b.textContent = 'הועתק';
    setTimeout(() => {{ b.textContent = was; }}, 1400);
  }} catch (err) {{
    const r = document.createRange(); r.selectNodeContents(out);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }}
}}
</script>
""")

out = os.path.join(HERE, "index-round22.html")
open(out, "w", encoding="utf-8").write("".join(parts))
size = os.path.getsize(out)
print(f"wrote {out}  ({len(data['cards'])} cards, {size // 1024}KB self-contained)")
