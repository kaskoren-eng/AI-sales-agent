"""
Builds the probe-26 laughter page — self-contained, phone-openable, audio inlined as base64.

Koren asked whether DeepDub can laugh. The probe answered the half a machine can answer:
  - `[laughter]`  inert. The Cartesia route is dead on this engine.
  - emoji         inert. Not spoken either — no risk, no laugh.
  - `חחח` / `הא הא`  +692ms / +1195ms of extra audio, and Soniox writes the letters back.

**And that is exactly where the instrument stops.** Soniox transcribing `חחח` is consistent with
BOTH a real laugh and her reading the letters aloud ("chet chet chet") — the transcript cannot
separate them, and the duration cannot either. Only his ear can, which is the whole reason this
page exists rather than a verdict.

Phone band only, like round 18: the 8kHz clip is what the lead hears, and it halves the bytes.

    python tests/hebrew-tts-niqqud-ab/build_probe26_page.py
"""
import base64, json, os, struct, wave

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

CARDS = [
    ("bl", "0 · הבסיס — בלי שום רמז", None,
     "כך היא נשמעת היום על המנוע החדש, בלי כלום. זה קו הייחוס לכל השאר.",
     [("A", "בלי כלום", "r26_base3.wav", "זאת שאלה טובה, אני אסביר.")]),
    ("dead", "1 · שתי הדרכים שלא עובדות", "אין הבדל",
     "התגית שעבדה על המנוע הישן, והאימוג'י. שתיהן לא מייצרות כלום — ובמקרה של האימוג'י זו גם בשורה טובה: "
     "הוא לא נאמר בקול, כלומר אם המודל יכתוב אימוג'י בטעות הליד לא ישמע אותו. אם אתה שומע כאן הבדל מהבסיס, אני טועה.",
     [("A", "‎[laughter]‎ — הדרך של קרטסיה", "r26_tag.wav", "[laughter] זאת שאלה טובה, אני אסביר."),
      ("B", "אימוג'י 😂", "r26_emo1.wav", "😂 זאת שאלה טובה, אני אסביר.")]),
    ("heb", "2 · צחוק כתוב — הדרך היחידה שמייצרת אודיו", "כאן ההכרעה שלךָ",
     "שתי האפשרויות האלה מייצרות אודיו נוסף אמיתי (‎+0.7 ו-‎+1.2 שניות). מה שאי אפשר לדעת בלי האוזן שלךָ: "
     "האם זה צחוק — או שהיא פשוט מקריאה את האותיות. התמלול מחזיר 'חחח' בשני המקרים, אז המכשיר לא יכול להכריע.",
     [("A", "חחח", "r26_heb1.wav", "חחח, זאת שאלה טובה, אני אסביר."),
      ("B", "הא הא", "r26_heb2.wav", "הא הא, זאת שאלה טובה, אני אסביר.")]),
]


def to_phone(src, dst):
    with wave.open(src, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    pcm = list(struct.unpack(f"<{len(raw) // 2}h", raw))
    if ch == 2:
        pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
    ratio = rate / PHONE_RATE
    out = []
    for i in range(int(len(pcm) / ratio)):
        a, b = int(i * ratio), min(int((i + 1) * ratio), len(pcm))
        win = pcm[a:b] or [0]
        out.append(int(round(sum(win) / len(win))))
    with wave.open(dst, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(PHONE_RATE)
        w.writeframes(struct.pack(f"<{len(out)}h", *out))
    return dst


def b64(path):
    return "data:audio/wav;base64," + base64.b64encode(open(path, "rb").read()).decode("ascii")


def dur_ms(path):
    with wave.open(path, "rb") as w:
        return round(w.getnframes() / w.getframerate() * 1000)


import html
e = html.escape

parts = ["""<title>יש לקרן צחוק?</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>
:root{--ground:#f6f7f9;--card:#fff;--line:#dfe3ea;--line-soft:#eaedf2;--ink:#131722;--mut:#666e80;
 --accent:#4a55c7;--accent-soft:#eceefb;--warn:#a34a1c;--warn-soft:#fbefe8;
 --sans:'Heebo',system-ui,'Segoe UI',Arial,sans-serif;--mono:'IBM Plex Mono',ui-monospace,Consolas,monospace;}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
 --ground:#0d1016;--card:#151a23;--line:#262d3a;--line-soft:#1d232e;--ink:#e6e9ef;--mut:#8d95a6;
 --accent:#8e97f5;--accent-soft:#1c2035;--warn:#e0915f;--warn-soft:#2a1f18;}}
:root[data-theme="dark"]{--ground:#0d1016;--card:#151a23;--line:#262d3a;--line-soft:#1d232e;
 --ink:#e6e9ef;--mut:#8d95a6;--accent:#8e97f5;--accent-soft:#1c2035;--warn:#e0915f;--warn-soft:#2a1f18;}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.65 var(--sans)}
.wrap{max-width:34rem;margin:0 auto;padding:24px 16px 140px}
h1{font-size:25px;line-height:1.25;font-weight:700;margin:0 0 10px;text-wrap:balance}
.lede{color:var(--mut);font-size:15px;margin:0}
.lede b{color:var(--ink);font-weight:500}
.rule{height:1px;background:var(--line);margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.chead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
h2{font-size:17px;font-weight:700;margin:0;flex:1 1 auto}
.len{font:600 12px/1 var(--mono);color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:5px 9px;white-space:nowrap}
.note{color:var(--mut);font-size:14px;margin:0 0 14px}
.opt{border:1px solid var(--line-soft);border-radius:10px;padding:12px;margin-bottom:10px;background:var(--ground)}
.otop{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.key{font:600 12px/1 var(--mono);color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:4px 7px}
.lab{font-size:14px;font-weight:500}
.delta{font:400 12px/1 var(--mono);color:var(--mut);margin-inline-start:auto}
.txt{font-size:15px;margin:0 0 10px;color:var(--mut)}
audio{width:100%;height:38px;display:block}
.pick{display:flex;align-items:center;gap:10px;margin-top:10px;padding:11px 10px;border:1px solid var(--line);
 border-radius:8px;cursor:pointer;font-size:15px;background:var(--card);min-height:46px}
.pick input{width:20px;height:20px;accent-color:var(--accent);margin:0}
.pick:has(input:checked){border-color:var(--accent);background:var(--accent-soft);font-weight:500}
.bar{position:fixed;inset-inline:0;bottom:0;background:var(--card);border-top:1px solid var(--line);
 padding:12px 16px calc(12px + env(safe-area-inset-bottom));display:flex;gap:10px;justify-content:center}
button{font:600 15px var(--sans);border:0;border-radius:9px;padding:13px 20px;cursor:pointer;background:var(--accent);color:#fff;min-height:46px}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--accent)}
#out{font:400 13px/1.7 var(--mono);background:var(--card);border:1px solid var(--line);border-radius:10px;
 padding:14px;white-space:pre-wrap;margin-top:16px;display:none;overflow-x:auto}
#out.on{display:block}
</style>
<div class="wrap">
<header>
<h1>יש לקרן צחוק על המנוע החדש?</h1>
<p class="lede">בדקתי ארבע דרכים. <b>שתיים מהן פשוט לא עושות כלום</b> — התגית שעבדה על קרטסיה, והאימוג'י.
<b>רק צחוק כתוב מייצר אודיו אמיתי.</b><br><br>
ומכאן המכשיר נעצר: התמלול מחזיר "חחח" גם אם היא צוחקת וגם אם היא מקריאה את האותיות.
<b>רק האוזן שלךָ יכולה להבדיל.</b><br><br>
פס טלפון 8kHz — בדיוק מה שהליד שומע.</p>
</header>
<div class="rule"></div>
"""]

for cid, title, badge, note, variants in CARDS:
    parts.append('<section class="card" dir="rtl">')
    parts.append(f'<div class="chead"><h2>{e(title)}</h2>'
                 + (f'<span class="len">{e(badge)}</span>' if badge else '') + '</div>')
    parts.append(f'<p class="note">{e(note)}</p>')
    for key, label, wav, text in variants:
        phone = to_phone(os.path.join(HERE, wav), os.path.join(HERE, wav.replace('.wav', '_phone.wav')))
        parts.append(
            f'<div class="opt"><div class="otop"><span class="key">{key}</span>'
            f'<span class="lab">{e(label)}</span><span class="delta">{dur_ms(phone)} ms</span></div>'
            f'<p class="txt">{e(text)}</p>'
            f'<audio controls preload="none" src="{b64(phone)}"></audio></div>'
        )
    if cid != "bl":
        opts = ([("laugh", "זה נשמע כמו צחוק"), ("letters", "היא מקריאה אותיות"), ("-", "אין הבדל מהבסיס")]
                if cid == "heb" else [("same", "זהה לבסיס — כמו שאמרתי"), ("diff", "יש הבדל, שמעתי משהו")])
        for val, lbl in opts:
            parts.append(f'<label class="pick"><input type="radio" name="p_{cid}" value="{val}">{lbl}</label>')
        if cid == "heb":
            parts.append('<label class="pick"><input type="radio" name="p_heb_w" value="A">'
                         'ואם זה צחוק — <b>חחח</b> עדיף</label>')
            parts.append('<label class="pick"><input type="radio" name="p_heb_w" value="B">'
                         'ואם זה צחוק — <b>הא הא</b> עדיף</label>')
    parts.append('</section>')

parts.append("""</div>
<div class="bar"><button onclick="s()">צור סיכום</button><button class="ghost" onclick="c()">העתק</button></div>
<pre id="out" dir="ltr"></pre>
<script>
const IDS=['dead','heb','heb_w'];
function s(){let t='probe26 verdicts (deepdub dd-etts-3.2, phone band)\\n';
 for(const id of IDS){const el=document.querySelector('input[name="p_'+id+'"]:checked');
  t+=id+': '+(el?el.value:'(no answer)')+'\\n';}
 const o=document.getElementById('out');o.textContent=t;o.classList.add('on');
 o.scrollIntoView({behavior:'smooth',block:'end'});}
async function c(){const o=document.getElementById('out');
 if(!o.classList.contains('on'))s();
 try{await navigator.clipboard.writeText(o.textContent);
  const b=document.querySelectorAll('.bar button')[1];const w=b.textContent;b.textContent='הועתק';
  setTimeout(()=>{b.textContent=w},1400);}
 catch(err){const r=document.createRange();r.selectNodeContents(o);
  const sel=getSelection();sel.removeAllRanges();sel.addRange(r);}}
</script>
""")

out = os.path.join(HERE, "index-probe26.html")
open(out, "w", encoding="utf-8").write("".join(parts))
print(f"wrote {out}  ({os.path.getsize(out) // 1024}KB self-contained)")
