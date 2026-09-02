"""
Builds index-round16.html from round16.json.

Generated rather than hand-written so a re-synth cannot leave the page pointing at clips that no
longer exist — round 7 was 33 clips Koren could not play, and every safeguard in this directory
exists because of a round that was wasted.

PHONE FIRST, like round 15, and here for a sharper reason than usual: the 8kHz band is where a
pause reads as a pause and not as a dropout. Judging rhythm on studio audio judges a call that
never happens.

Two controls per card rather than one. "Which is best" is the wrong question on its own for the
`br` card — a tag that gets READ ALOUD is not a worse pause, it is a disqualification — so every
card also carries a free-text box for what actually came out. That box is the round's real output
for `br` and `df`, where the failure mode is a word appearing rather than a pause being wrong.
"""
import json, os, html

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "round16.json"), encoding="utf-8"))

e = html.escape
parts = ["""<meta charset="utf-8"><title>סבב 16 — קצב</title>
<style>
:root{--bg:#0f1115;--fg:#e8eaed;--mut:#9aa0a6;--card:#171a21;--line:#262b36;--acc:#7c8cff;--warm:#ffb86b;--warn:#ff6b6b}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,Segoe UI,Arial;padding:28px}
h1{font-size:22px;margin:0 0 6px} h2{font-size:16px;margin:0 0 8px;color:var(--acc)}
.intro{max-width:74ch;color:var(--mut);margin-bottom:26px} .intro b{color:var(--fg)}
.note{color:var(--mut);font-size:13px;margin-bottom:12px;max-width:78ch} .note b{color:var(--fg)}
code{background:#12151c;border:1px solid var(--line);border-radius:4px;padding:0 5px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.vs{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.v{border:1px solid var(--line);border-radius:8px;padding:12px;background:#12151c}
.k{display:inline-block;font-weight:700;background:var(--acc);color:#0f1115;border-radius:4px;padding:0 8px;margin-bottom:6px}
.lab{color:var(--mut);font-size:13px;margin-bottom:6px} .txt{font-size:16px;margin-bottom:10px}
.sp{font-size:12px;color:var(--warm);margin-bottom:8px;letter-spacing:.03em}
.tag{font-size:11px;color:var(--mut);margin:6px 0 2px;letter-spacing:.04em}
.tag b{color:var(--warm)}
audio{width:100%;margin-bottom:2px} .pick{display:block;margin-top:10px;font-size:13px;cursor:pointer}
.warn{border-color:var(--warn)} .warnbox{border:1px solid var(--warn);border-radius:8px;padding:10px 12px;margin-bottom:12px;color:#ffd7d7;font-size:13px}
textarea{width:100%;box-sizing:border-box;margin-top:10px;background:#0f1115;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:13px/1.5 system-ui;min-height:52px}
button{background:var(--acc);color:#0f1115;border:0;border-radius:8px;padding:10px 18px;font-size:15px;font-weight:600;cursor:pointer}
pre{background:#12151c;border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap}
</style>
<h1>סבב 16 — קצב</h1>
<div class="intro" dir="rtl">
הסבב הראשון על <b>כמה מהר היא מדברת</b> ולא על איך היא מאייתת.<br><br>
<b>למה ה-A/B של השיחה לא יכול היה לענות על זה.</b> שם כל וריאנט הוא שיחה נפרדת, אז המודל כותב
<b>משפטים שונים</b> בכל אחת — והשוואה כזו משווה ניסוח ומסירה יחד, כשהניסוח מנצח תמיד. לכן לא
הצלחת להכריע שש מתוך שמונה שורות. כאן <b>כל וריאנט בכרטיס הוא בדיוק אותו טקסט</b>, אז הדבר
היחיד שמשתנה הוא הדבר שנבדק.<br><br>
sonic-3.5, עוצמה 1.4 — בדיוק כמו בפרודקשן. <b>שמע קודם את קובץ פס הטלפון (8kHz)</b>: פאוזה
נשמעת כפאוזה רק שם; באיכות מלאה היא נשמעת כמו שקט מכוון בכל מקרה.<br><br>
בכל כרטיס יש גם תיבת טקסט. <b>בכרטיסים 3 ו-5 היא חשובה יותר מהבחירה</b> — שם הכישלון הוא
מילה שנשמעת, לא פאוזה שלא מוצלחת.
</div>
"""]

WARN = {
    "br": "לפני כל דבר אחר: תשמע אם המילה <b>break</b> נאמרת בקול באחד הקליפים D או E. "
          "אם כן — הקלף מת, ואומרים את זה מיד. זה כל הסיכון של הלבר הזה.",
    "df": "כל האיותים כאן <b>לא עברו סינון מעולם</b>. כשלון של מילת ביניים בעברית הוא שקט: "
          "\"חח\" יצא כאות חית, \"אוו\" נבלע לגמרי. אם משהו נשמע כמו אות ולא כמו סאונד — תכתוב.",
}

for card in data["cards"]:
    parts.append(f'<section><h2>{e(card["title"])}</h2>')
    if card["id"] in WARN:
        parts.append(f'<div class="warnbox" dir="rtl">⚠️ {WARN[card["id"]]}</div>')
    parts.append(f'<div class="note" dir="rtl">{e(card["note"])}</div><div class="vs">')
    for v in card["variants"]:
        speeds = " → ".join(str(s) for s in v["speeds"])
        parts.append(
            f'<div class="v"><div class="k">{e(v["key"])}</div>'
            f'<div class="lab">{e(v["label"])}</div>'
            f'<div class="sp">speed {e(speeds)}</div>'
            f'<div class="txt" dir="rtl">{e(v["text"])}</div>'
            f'<div class="tag"><b>פס טלפון 8kHz — זה מה שהוא שומע</b></div>'
            f'<audio controls preload="none" src="{e(v["phone"])}"></audio>'
            f'<div class="tag">איכות מלאה 44.1kHz — להשוואה בלבד</div>'
            f'<audio controls preload="none" src="{e(v["file"])}"></audio>'
            f'<label class="pick"><input type="radio" name="pick_{e(card["id"])}" '
            f'value="{e(v["key"])}"> זה הכי טוב</label></div>'
        )
    parts.append("</div>")
    parts.append(
        f'<textarea id="say_{e(card["id"])}" dir="rtl" '
        f'placeholder="מה שמעת בפועל? (אם משהו נשמע לא נכון — כאן)"></textarea>'
    )
    parts.append("</section>")

ids = [c["id"] for c in data["cards"]]
parts.append(
    '<button onclick="s()">צור סיכום</button>\n<pre id="out" dir="ltr"></pre>\n<script>\n'
    "function s(){\n"
    f"  const ids={json.dumps(ids)};\n"
    "  let t='round16 verdicts (sonic-3.5, vol 1.4)\\n';\n"
    "  for(const id of ids){\n"
    "    const el=document.querySelector('input[name=\"pick_'+id+'\"]:checked');\n"
    "    const note=(document.getElementById('say_'+id)||{}).value||'';\n"
    "    t+=id+': '+(el?el.value:'-')+(note.trim()?('  // '+note.trim().replace(/\\n/g,' ')):'')+'\\n';\n"
    "  }\n"
    "  document.getElementById('out').textContent=t;\n"
    "}\n</script>\n"
)

out = os.path.join(HERE, "index-round16.html")
open(out, "w", encoding="utf-8").write("".join(parts))
print(f"wrote {out}  ({len(data['cards'])} cards, "
      f"{sum(len(c['variants']) for c in data['cards'])} variants)")
