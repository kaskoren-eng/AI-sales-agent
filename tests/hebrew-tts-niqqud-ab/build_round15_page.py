"""
Builds index-round15.html from round15.json (+ round15-heard.json if present).

Generated rather than hand-written so a re-synth cannot leave the page pointing at clips that no
longer exist — round 7 was 33 clips Koren could not play, and every safeguard in this directory
exists because of a round that was wasted.

PHONE FIRST. Each variant shows the 8kHz player above the 44.1kHz one, because the phone clip is
the one that decides: `נוח` collapsing into `נח` is a phone-band artefact, and judging it on studio
audio is judging a call that never happens.
"""
import json, os, html

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "round15.json"), encoding="utf-8"))
heard_path = os.path.join(HERE, "round15-heard.json")
heard = json.load(open(heard_path, encoding="utf-8")) if os.path.exists(heard_path) else {}

e = html.escape
parts = ["""<meta charset="utf-8"><title>סבב 15 — נוח, ליד</title>
<style>
:root{--bg:#0f1115;--fg:#e8eaed;--mut:#9aa0a6;--card:#171a21;--line:#262b36;--acc:#7c8cff;--warm:#ffb86b}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,Segoe UI,Arial;padding:28px}
h1{font-size:22px;margin:0 0 6px} h2{font-size:16px;margin:0 0 8px;color:var(--acc)}
.intro{max-width:74ch;color:var(--mut);margin-bottom:26px} .intro b{color:var(--fg)}
.note{color:var(--mut);font-size:13px;margin-bottom:12px;max-width:76ch} .note b{color:var(--fg)}
code{background:#12151c;border:1px solid var(--line);border-radius:4px;padding:0 5px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.vs{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.v{border:1px solid var(--line);border-radius:8px;padding:12px;background:#12151c}
.k{display:inline-block;font-weight:700;background:var(--acc);color:#0f1115;border-radius:4px;padding:0 8px;margin-bottom:6px}
.lab{color:var(--mut);font-size:13px;margin-bottom:6px} .txt{font-size:16px;margin-bottom:10px}
.tag{font-size:11px;color:var(--mut);margin:6px 0 2px;letter-spacing:.04em}
.tag b{color:var(--warm)}
audio{width:100%;margin-bottom:2px} .pick{display:block;margin-top:10px;font-size:13px;cursor:pointer}
.heard{font-size:12px;color:var(--mut);margin-top:8px;border-top:1px solid var(--line);padding-top:6px}
button{background:var(--acc);color:#0f1115;border:0;border-radius:8px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}
pre{background:#12151c;border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap}
</style>
<h1>סבב 15 — שתי המילים שהיא לא יודעת לבטא</h1>
<div class="intro" dir="rtl">
<b>נוח</b> יוצא "נח", ו<b>ליד</b> יוצא "לְיַד" (על יד). עצרת שיחה חיה על השנייה, פעמיים.<br><br>
בכל כרטיס <b>A = מה שהיא אומרת היום</b>. שלוש הטכניקות שאי פעם ניצחו בניסוי הזה מיוצגות בכל
מילה — ניקוד מינימלי, איות פונטי, ולוותר על המילה — כי אף טכניקה לא ניצחה כאן פעמיים ברצף:
<code>שלךָ</code> נבחר על סימן ניקוד, <code>איתכה</code> נבחר על איות פונטי, וכל אחת הוכרעה
בנפרד באוזן.<br><br>
sonic-3.5, מהירות 0.9, עוצמה 1.4 — בדיוק כמו בפרודקשן.
<b>שמע קודם את הקובץ של פס הטלפון (8kHz)</b> — זה מה שהלקוח שומע, ושם המילה נשברת מלכתחילה.
הקובץ באיכות מלאה נמצא מתחתיו רק להשוואה.<br><br>
<b>הבדיקה האוטומטית לא הצליחה להכריע כאן.</b> חמש האופציות של "נוח" חזרו מהתמלול כאותה מילה
בדיוק — עברית נכתבת בלי תנועות, אז "נוֹחַ" ו"נַח" הן אותן שלוש אותיות. האוזן שלךָ מכריעה לבד.
</div>
"""]

for card in data["cards"]:
    parts.append(f'<section><h2>{e(card["id"])} · {e(card["title"])}</h2>')
    parts.append(f'<div class="note" dir="rtl">{e(card["note"])}</div><div class="vs">')
    for v in card["variants"]:
        key = f'{card["id"]}_{v["key"]}'
        parts.append(
            f'<div class="v"><div class="k">{e(v["key"])}</div>'
            f'<div class="lab">{e(v["label"])}</div>'
            f'<div class="txt" dir="rtl">{e(v["text"])}</div>'
            f'<div class="tag"><b>פס טלפון 8kHz — זה מה שהוא שומע</b></div>'
            f'<audio controls preload="none" src="{e(v["phone"])}"></audio>'
            f'<div class="tag">איכות מלאה 44.1kHz — להשוואה בלבד</div>'
            f'<audio controls preload="none" src="{e(v["file"])}"></audio>'
            f'<label class="pick"><input type="radio" name="pick_{e(card["id"])}" value="{e(v["key"])}"> זה הכי טוב</label>'
        )
        if key in heard:
            parts.append(f'<div class="heard" dir="rtl">התמלול שמע: {e(heard[key]) or "(כלום)"}</div>')
        parts.append("</div>")
    parts.append("</div></section>")

ids = [c["id"] for c in data["cards"]]
parts.append(
    '<button onclick="s()">צור סיכום</button>\n<pre id="out" dir="ltr"></pre>\n<script>\n'
    "function s(){\n"
    f"  const ids={json.dumps(ids)};\n"
    "  let t='round15 verdicts (sonic-3.5)\\n';\n"
    "  for(const id of ids){const el=document.querySelector('input[name=\"pick_'+id+'\"]:checked');\n"
    "  t+=id+': '+(el?el.value:'-')+'\\n';}\n"
    "  document.getElementById('out').textContent=t;\n"
    "}\n</script>\n"
)

out = os.path.join(HERE, "index-round15.html")
open(out, "w", encoding="utf-8").write("".join(parts))
print(f"wrote {out}  ({len(data['cards'])} cards, "
      f"{sum(len(c['variants']) for c in data['cards'])} variants, "
      f"{'with' if heard else 'without'} round-trip transcripts)")
