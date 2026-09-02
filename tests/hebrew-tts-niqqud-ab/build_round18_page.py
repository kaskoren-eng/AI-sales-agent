"""
Builds the round-18 page as ONE self-contained HTML file with the audio inlined.

Every other page in this directory is a local file pointing at sibling WAVs, which is fine on the
machine that generated them and useless anywhere else. Koren asked for this one on his phone, so
the clips are base64 data URIs and the file has no dependencies at all — no server, no siblings,
no network beyond the font.

Design notes, so the next person does not have to reverse-engineer them:
  - The house palette from CLAUDE.md (cool technical, indigo accent, mono for data, no gradients),
    because this is an instrument for the same product and inventing a second identity for it
    would be decoration.
  - Heebo for the Hebrew, IBM Plex Mono for anything that is data — the tag lengths, the deltas,
    the verdict block. Hebrew-first pairing, not a Latin face with Hebrew fallback.
  - Each card shows the MEASURED difference the pause makes, in milliseconds, read off the WAVs.
    That is the quantity under test, and it belongs on the page as information rather than as
    something the reader has to take on trust.
  - The two negative controls carry a different stripe and say plainly that B is expected to sound
    wrong. A page that only shows the good cases cannot tell you whether the rule is right.

    python tests/hebrew-tts-niqqud-ab/build_round18_page.py
"""
import html, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "round18.json"), encoding="utf-8"))
e = html.escape

NEGATIVE = {"nc", "ng"}


def duration_ms(byte_len: int) -> int:
    """8kHz mono 16-bit: (bytes - 44 header) / 2 samples, over 8000 per second."""
    return round((byte_len - 44) / 2 / 8000 * 1000)


parts = ["""<title>סבב 18 — הפאוזה במקומה</title>
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
<h1>הפאוזה, במקום שבו הקוד באמת ישים אותה</h1>
<p class="lede">כל משפט כאן לקוח <b>מהפרומפט החי או מטקסט של כלי</b> — לא נכתב לעמוד.
<b>A</b> זה מה שהיא אומרת היום. <b>B</b> זה עם הפאוזה.<br><br>
שני כרטיסים מסומנים באדום הם <b>בקרה שלילית</b>: שם הפרומפט אוסר פאוזה במפורש, ו-B הוא
מה שיקרה אם הכלל לא יחזיק. אם B נשמע שם בסדר — הכלל מחמיר מדי. אם הוא נשמע מזויף — הכלל עובד.<br><br>
כל הקליפים בפס טלפון 8kHz, sonic-3.5, 0.9/1.4 — בדיוק מה שהליד שומע.</p>
</header>
<div class="rule"></div>
"""]

for i, card in enumerate(data["cards"], 1):
    neg = card["id"] in NEGATIVE
    parts.append(f'<section class="card{" neg" if neg else ""}" dir="rtl">')
    parts.append(
        f'<div class="chead"><h2>{e(card["title"])}</h2>'
        f'<span class="len">{e(card["length"])}</span></div>'
    )
    parts.append(f'<p class="note">{e(card["note"])}</p>')
    base = duration_ms(card["variants"][0]["bytes"])
    for v in card["variants"]:
        ms = duration_ms(v["bytes"])
        delta = "" if v["key"] == "A" else f'<span class="delta">+{ms - base} ms</span>'
        parts.append(
            f'<div class="opt"><div class="otop"><span class="key">{v["key"]}</span>'
            f'<span class="delta">{ms} ms</span>{delta}</div>'
            f'<p class="txt">{e(v["text"])}</p>'
            f'<audio controls preload="none" src="{v["wav"]}"></audio>'
            f'<label class="pick"><input type="radio" name="p_{card["id"]}" value="{v["key"]}">'
            f'{"נשמע נכון" if not neg else "זה נשמע בסדר"}</label></div>'
        )
    parts.append(
        f'<label class="pick"><input type="radio" name="p_{card["id"]}" value="-">'
        f'{"שניהם אותו דבר" if not neg else "B נשמע מזויף — הכלל צודק"}</label>'
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
  let t = 'round18 verdicts (sonic-3.5, 0.9/1.4, phone band)\\n';
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
    // Clipboard permission is refused often enough on mobile that a silent failure would look
    // like the button doing nothing. Select the text instead so a long-press can copy it.
    const r = document.createRange(); r.selectNodeContents(out);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }}
}}
</script>
""")

out = os.path.join(HERE, "index-round18.html")
open(out, "w", encoding="utf-8").write("".join(parts))
size = os.path.getsize(out)
print(f"wrote {out}  ({len(data['cards'])} cards, {size // 1024}KB self-contained)")
