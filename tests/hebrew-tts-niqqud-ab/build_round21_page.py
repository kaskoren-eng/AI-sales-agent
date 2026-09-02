"""
Builds the round-21 page — ONE self-contained HTML file, audio inlined as base64 data URIs.

Same skeleton, palette and reasoning as build_round18_page.py (see the design notes there: house
palette from CLAUDE.md, Heebo + IBM Plex Mono, phone-first, negative controls on a warn stripe,
verdict summary + copy). What round 21 adds:
  - card b0 is an INSTRUMENT card (veto the breath sources themselves), styled as a regular card
    but with its own pick labels — "זו נשימה" / "זה לא נשמע כמו נשימה".
  - each variant prints its measured duration; the delta only where a breath was inserted.

    python tests/hebrew-tts-niqqud-ab/build_round21_page.py
"""
import base64, html, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "round21.json"), encoding="utf-8"))
e = html.escape

NEGATIVE = {"b4", "b5"}
INSTRUMENT = {"b0"}

parts = ["""<title>סבב 21 — הנשימה</title>
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
.rule{height:1px;background:var(--line);margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.card.neg{border-color:var(--warn);background:var(--warn-soft)}
.chead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
h2{font-size:17px;font-weight:700;margin:0;flex:1 1 auto}
.len{font:600 12px/1 var(--mono);color:var(--accent);background:var(--accent-soft);
     border-radius:999px;padding:5px 9px;white-space:nowrap}
.card.neg .len{color:var(--warn);background:transparent;border:1px solid var(--warn)}
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
.card.neg .pick:has(input:checked){border-color:var(--warn);background:transparent}
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
<h1>נשימה. בפעם הראשונה שיש מה לשמוע</h1>
<p class="lede">תגי הנשימה של קרטסיה מתים בעברית — נבדק היום על sonic-3.5 וגם 3.6
(רק <b>[laughter]</b> עובד, והצחוק אסור). אז הנשימות כאן הן <b>אודיו שאנחנו שותלים</b>
בין הפריימים — בדיוק מה שהקוד יעשה בפרודקשן.<br><br>
<b>כרטיס 0 קודם לכולם</b>: אם מקור לא נשמע לך כמו נשימה — כל הכרטיסים שבנויים עליו נופלים.<br><br>
שני כרטיסים אדומים הם <b>בקרה שלילית</b>: שם הנשימה אמורה להישמע לא במקום. אם היא דווקא
בסדר שם — החוק שתכננו מחמיר מדי.<br><br>
כל הקליפים בפס טלפון 8kHz, sonic-3.5, ‎0.9/1.4 — מה שהליד שומע.</p>
</header>
<div class="rule"></div>
"""]


def b64(path):
    raw = open(os.path.join(HERE, path), "rb").read()
    return "data:audio/wav;base64," + base64.b64encode(raw).decode("ascii")


for card in data["cards"]:
    cid = card["id"]
    neg = cid in NEGATIVE
    inst = cid in INSTRUMENT
    parts.append(f'<section class="card{" neg" if neg else ""}" dir="rtl">')
    badge = card["warn"] if card.get("warn") else ("כרטיס מכשיר" if inst else "A/B")
    parts.append(
        f'<div class="chead"><h2>{e(card["title"])}</h2>'
        f'<span class="len">{e(badge)}</span></div>'
    )
    parts.append(f'<p class="note">{e(card["note"])}</p>')
    base = card["variants"][0]["ms"]
    for v in card["variants"]:
        delta = ""
        if v["key"] != "A" and not inst:
            d = v["ms"] - base
            delta = f'<span class="delta">{"+" if d >= 0 else ""}{d} ms</span>'
        parts.append(
            f'<div class="opt"><div class="otop"><span class="key">{v["key"]}</span>'
            f'<span class="delta">{v["ms"]} ms</span>{delta}</div>'
            f'<p class="txt">{e(v["label"])}</p>'
            f'<audio controls preload="none" src="{b64(v["file"])}"></audio>'
        )
        if inst:
            parts.append(
                f'<label class="pick"><input type="checkbox" name="p_{cid}_{v["key"]}" value="ok">'
                f'זו נשימה — אפשר לעבוד איתה</label></div>'
            )
        else:
            parts.append(
                f'<label class="pick"><input type="radio" name="p_{cid}" value="{v["key"]}">'
                f'{"נשמע נכון" if not neg else "זה נשמע בסדר"}</label></div>'
            )
    if not inst:
        parts.append(
            f'<label class="pick"><input type="radio" name="p_{cid}" value="-">'
            f'{"אף אחד — בלי נשימה עדיף" if not neg else "B נשמע מזויף — הכלל צודק"}</label>'
        )
    parts.append("</section>")

ids = [c["id"] for c in data["cards"] if c["id"] not in INSTRUMENT]
inst_keys = [[c["id"], [v["key"] for v in c["variants"]]] for c in data["cards"] if c["id"] in INSTRUMENT]
parts.append(f"""</div>
<div class="bar">
  <button onclick="summarise()">צור סיכום</button>
  <button class="ghost" onclick="copyOut()">העתק</button>
</div>
<pre id="out" dir="ltr"></pre>
<script>
const IDS = {json.dumps(ids)};
const INST = {json.dumps(inst_keys)};
function summarise(){{
  let t = 'round21 verdicts (breath mix, sonic-3.5 + dd-etts breath, phone band)\\n';
  for (const [cid, keys] of INST) {{
    const ok = keys.filter(k => document.querySelector('input[name="p_' + cid + '_' + k + '"]:checked'));
    t += cid + ': sources ok = ' + (ok.length ? ok.join(',') : '(none)') + '\\n';
  }}
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

out = os.path.join(HERE, "index-round21.html")
open(out, "w", encoding="utf-8").write("".join(parts))
size = os.path.getsize(out)
print(f"wrote {out}  ({len(data['cards'])} cards, {size // 1024}KB self-contained)")
