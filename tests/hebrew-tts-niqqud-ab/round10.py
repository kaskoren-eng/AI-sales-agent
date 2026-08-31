"""
Round 10 — the filler and receipt words, judged by SOUND. The round he asked for twice.

WHY IT IS BEING BUILT TWICE. Koren asked for exactly this on 2026-08-30:

    "מילות המילוי נאמרות באופן מוזר, במקום להגיד אהה הסוכן אומר אוהה או אההא, צריך שתיצור לי
     מבחן קולי ואבחר אופציות נכונות"

Round 6 was built for it the same day, cards `fl1`–`fl5`. He could not judge a single clip: every
WAV in rounds 1–8 carried the streaming placeholder 0xFFFFFFFF in both size fields, and browsers
disagree about such a file — some play it, some play noise, some refuse, none say why (wavcheck.py).
So the spelling was never chosen, `אהה` is still in ACKNOWLEDGEMENTS_HE exactly as it was, and it
has been spoken on every production call since. On 2026-08-31, after the 13:52 call on d7da334, he
said it again with the diagnosis attached:

    "היא אומרת את ה-Filler Words בצורה שהיא לא טובה; היא אומרת 'או-ה' במקום 'אהההה' אחיד"

Two syllables with a break in the middle, where he wants one continuous sound. That is the thing to
listen for on card f1, and it is the only thing.

═══════════════════════════════════════════════════════════════════════════════════════════════
TRANSCRIBED CORRECTLY ≠ PRONOUNCED CORRECTLY. THIS ROUND IS ABOUT THE SECOND ONE.
═══════════════════════════════════════════════════════════════════════════════════════════════

Every earlier round verified its wording by ROUND TRIP: synthesize, squeeze through an 8kHz phone
line, transcribe with Soniox, check the intended word came back. That catches a word the band
destroys — `נוח` → `נח`, `רק לוודא` → `רק לוועדה` — and it is why those checks exist.

It cannot catch a word that comes back perfectly and sounds wrong on the way. Soniox will happily
write `אהה` whether Cartesia said one steady vowel or "או-ה" with a glottal break in the middle,
because both are the same word. So a green round trip has never been evidence about pronunciation,
and treating it as such is how `אהה` reached production unscreened.

WHAT IS ACTUALLY SCREENED, in full, because the honest answer is "almost none of it":

    NEVER LISTENED TO — every member of both banks
      אהה. אוקיי. בסדר.          ACKNOWLEDGEMENTS_HE. Spoken on nearly every turn of every
                                 production call since instant-ack shipped.
      הבנתי אותך. טוב, הבנתי.    ACK_COMPREHENSION_HE. Judged on FREQUENCY (2026-08-31: "יותר מדי
                                 פעמים", moved to earned) — never on sound.
      אממ... רגע... שנייה... אה...  THINKING_FILLERS_HE. Round 6 offered spellings for `אה`; unjudged.
      אה אה.                     DICTATION_NOD. Round 6 offered five spellings; unjudged.

    SCREENED AND VERIFIED — the pronunciation dictionary only
      שלךָ לךָ אותךָ אליךָ איתכה …   rounds 3 / 3b / 3c, by ear AND round trip
      לוודֵא                      round 3 (vd1+vd2 = C), re-tested round 6
      רוצֶה / רוצָה                round 6

CARRIERS ARE NOT DECORATION. `llmNode` injects the receipt at the head of the reply STREAM, so
Cartesia synthesizes "<word> <first sentence>" as one continuous transcript and never the word on
its own. A bare clip is not the thing he heard on the phone. The one exception is the
mid-dictation nod, which really is spoken alone while the caller is still reading out a number —
so that section has no carrier, on purpose.

NOTHING IN THE BANKS IS CHANGED BY THIS FILE, and that is a rule rather than modesty. An
unscreened Hebrew interjection fails SILENTLY: round 4b is the precedent, where written laughter
came back as the NAMES of its letters and `אוו` vanished from the transcript entirely. A spelling
picked from theory is a spelling nobody has heard.

PRODUCTION PARITY — sonic-3.5 at VOICE_TTS_SPEED=0.9 / VOICE_TTS_VOLUME=1.4, like rounds 6–9, and
every clip's header is repaired and verified at the moment of writing, so these play.

    python tests/hebrew-tts-niqqud-ab/round10.py              # synth + write index-round10.html
    npx tsx tests/hebrew-tts-niqqud-ab/roundtrip10.ts         # 8kHz phone band -> Soniox
    python tests/hebrew-tts-niqqud-ab/round10.py              # re-run to fold the transcripts in
    python tests/hebrew-tts-niqqud-ab/round10.py --resynth    # regenerate every clip
"""
import html as htmlmod
import json
import os
import sys

# The Windows console this repo is developed on is cp1252 and every progress line here is Hebrew.
# Without this the run dies on the FIRST print — after it has already paid Cartesia for the clip.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # pragma: no cover
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth
from round3 import dur

synthmod.MODEL = os.environ.get("ROUND10_MODEL", "sonic-3.5")
synthmod.GENERATION_CONFIG = {
    "speed": float(os.environ.get("ROUND10_SPEED", "0.9")),
    "volume": float(os.environ.get("ROUND10_VOLUME", "1.4")),
}

SHEVA, TSERE, SEGOL, PATACH, KAMATZ, HOLAM = "ְ", "ֵ", "ֶ", "ַ", "ָ", "ֹ"

# The carrier a receipt is spoken in — the first discovery question of the 2026-08-31 call, verbatim.
Q = "כמה פניות נכנסות אליךָ ביום?"
# …and the carrier a thinking filler lands in front of.
T = "בוא נבדוק מה הכי מתאים לעסק שלךָ."

# (card_id, section, what it asks, [(key, label, text)], [round-trip fragments], [scored keys])
#
# `hear` / `score` drive roundtrip10.ts, and MOST OF THIS ROUND IS DELIBERATELY UNSCORED. A
# transcriber has no opinion about whether `אהה` came out as one steady vowel or as "או-ה", and a
# green tick under a clip only Koren can judge would be the exact confusion this round exists to
# undo. What the round trip is still good for here is the one failure an ear can miss on a page:
# a clip whose transcript comes back EMPTY, i.e. the band swallowed the sound completely. The page
# marks those in red.
#
# The two REAL WORDS (`רגע`, `שנייה`) are scored, because for a word the round trip is a genuine
# second test — it is the check that caught `נוח` → `נח`.
# Which carrier each section speaks its candidate in, so the round-trip reading can be split into
# "what came back for the WORD" and "what came back for the sentence after it".
#
# THIS IS THE DIFFERENCE BETWEEN A TRANSCRIPT AND A RESULT. The first run of this round produced
# `f1_B` → "כמה פניות נכנסות אליך ביום?" — the carrier came back perfectly and the interjection was
# simply not there. That is round 4b's `אוו` failure happening again, and on a page showing raw
# transcripts it looks like an ordinary line. Only by subtracting the carrier does it read as what
# it is: the sound did not survive the phone band.
CARRIER_OF_SECTION = {
    "receipt": Q,
    "hesitation": T,
    "words": T,
    "receipts": Q,
    "nod": "",  # the nod is spoken alone — there is nothing to subtract
}

CARDS = [
    # ── 1 · the sound he has now complained about twice ──────────────────────────────────────
    ("f1", "receipt", "אהה — הקבלה שנשמעת לךָ כ״או-ה״", [
        ("A", "היום, כמו שהיא בבנק", f"אהה. {Q}"),
        ("B", "אההה — ה׳ אחת יותר", f"אההה. {Q}"),
        ("C", "אהההה — כמו שכתבת", f"אהההה. {Q}"),
        ("D", "אה — בית אחד בלבד", f"אה. {Q}"),
        ("E", "אמ — סגירת שפתיים במקום פתיחה", f"אמ. {Q}"),
        ("F", "אֶהֶה — סגול על שתי האותיות", f"א{SEGOL}ה{SEGOL}ה. {Q}"),
        ("G", "אֶההה — סגול על האל״ף בלבד", f"א{SEGOL}ההה. {Q}"),
        ("H", "אֶהְהה — סגול ואז שווא (בלי הברה שנייה)", f"א{SEGOL}ה{SHEVA}הה. {Q}"),
    ], [], []),

    # ── 2 · the hesitations — a different act from a receipt, same raw sound ─────────────────
    ("f2", "hesitation", "אה... — ההיסוס", [
        ("A", "היום (אה...)", f"אה... {T}"),
        ("B", "אהה...", f"אהה... {T}"),
        ("C", "אההה...", f"אההה... {T}"),
        ("D", "אֶה... — סגול", f"א{SEGOL}ה... {T}"),
    ], [], []),

    ("f3", "hesitation", "אממ... — ההיסוס הסגור", [
        ("A", "היום (אממ...)", f"אממ... {T}"),
        ("B", "אמ... — מ׳ אחת", f"אמ... {T}"),
        ("C", "אממם... — מוארך", f"אממם... {T}"),
        ("D", "אֶממ... — סגול", f"א{SEGOL}ממ... {T}"),
    ], [], []),

    # ── 3 · the two fillers that are real Hebrew words, never put through a phone line ───────
    ("f4", "words", "רגע... — מעולם לא עברה קו טלפון", [
        ("A", "היום (רגע...)", f"רגע... {T}"),
        ("B", "רֶגַע... — מנוקדת", f"ר{SEGOL}ג{PATACH}ע... {T}"),
    ], ["רגע"], ["A", "B"]),

    ("f5", "words", "שנייה... — מעולם לא עברה קו טלפון", [
        ("A", "היום (שנייה...)", f"שנייה... {T}"),
        ("B", "שניה... — כתיב חסר", f"שניה... {T}"),
    ], ["שנייה", "שניה"], ["A", "B"]),

    # ── 4 · the receipts she says on nearly every turn, and nobody ever listened to ──────────
    ("a1", "receipts", "אוקיי. — נאמרת בכל שיחה, מעולם לא נשמעה בבדיקה", [
        ("A", "היום", f"אוקיי. {Q}"),
        ("B", "אוקי — בלי היו״ד הכפולה", f"אוקי. {Q}"),
    ], ["אוקיי", "אוקי"], ["A", "B"]),

    ("a2", "receipts", "בסדר. — אותו דבר", [
        ("A", "היום", f"בסדר. {Q}"),
    ], ["בסדר"], ["A"]),

    ("a3", "receipts", "הבנתי אותךָ. — נשפטה על תדירות, לא על צליל", [
        ("A", "היום", f"הבנתי אותךָ. {Q}"),
    ], ["הבנתי אות"], ["A"]),

    ("a4", "receipts", "טוב, הבנתי. — אותו דבר", [
        ("A", "היום", f"טוב, הבנתי. {Q}"),
    ], ["הבנתי"], ["A"]),

    # ── 5 · the nod, which really IS spoken alone ───────────────────────────────────────────
    ("n1", "nod", "אה אה. — ההנהון באמצע הכתבת מספר (נאמר לבד)", [
        ("A", "היום (אה אה.)", "אה אה."),
        ("B", "אהה.", "אהה."),
        ("C", "אה-אה.", "אה-אה."),
        ("D", "אַה אַה — פתח", f"א{PATACH}ה א{PATACH}ה."),
    ], [], []),
]

GROUPS = [
    ("receipt", "1 · אהה — המילה שהתלוננת עליה פעמיים",
     "זאת המילה מההערה שלךָ: <b>״היא אומרת 'או-ה' במקום 'אהההה' אחיד״</b>. תקשיב לדבר אחד בלבד — "
     "<b>האם זה צליל אחד רציף, או שתי הברות עם עצירה באמצע</b>. אל תשפוט את המשפט שאחריה, הוא זהה "
     "בכל הקליפים בכוונה.<br><br>"
     "A זה מה שהיא אומרת היום. B ו-C מאריכים את התנועה באותיות. D ו-E הם צלילים אחרים לגמרי. "
     "F, G ו-H מנקדים — והטכניקה שניצחה בסבב 3 היא בדיוק זאת של G: <b>סימן אחד על האות המסופקת "
     "בלבד</b>, לא ניקוד מלא. ב-H יש שווא על ה׳ הראשונה, שאמור למנוע הברה שנייה.<br><br>"
     "כל הקליפים נאמרים <b>בתוך משפט</b>, כי ככה הפרודקשן אומר אותם: המילה מוזרקת לראש זרם התשובה "
     "וקרטזיה מקבלת ״מילה + משפט״ כטקסט אחד. קליפ של המילה לבד לא היה מה ששמעת בטלפון."),

    ("hesitation", "2 · אה... ואממ... — ההיסוסים",
     "אלה מילים אחרות מ-אהה גם אם הצליל דומה: <b>קבלה אומרת ״שמעתי אותךָ״, היסוס אומר ״אני "
     "חושבת״</b>. הן נאמרות לכל היותר שלוש פעמים בשיחה, לפני תשובה שמתעכבת, ואף אחת מהן לא נשמעה "
     "בבדיקה מעולם. אם אחת נשמעת רע — היא יורדת מהבנק. לא מנחשים לה איות."),

    ("words", "3 · רגע ושנייה — מילים אמיתיות שלא עברו קו טלפון",
     "אלה לא הברות אלא מילים רגילות, ולכן <b>כאן לתמלול כן יש מה להגיד</b>: אם המילה לא חוזרת "
     "מהמכונה, הקו בלע אותה. זאת בדיוק התקלה שהחזירה ״נח״ במקום ״נוח״ ו״רק לוועדה״ במקום ״רק "
     "לוודא״.<br><br>"
     "<b>אבל תמלול תקין הוא לא הוכחה שההגייה טובה</b> — זה בדיוק ההבדל שהסבב הזה קיים בשבילו. "
     "התמלול אומר ״המילה שרדה את הקו״; רק האוזן שלךָ אומרת ״ככה אומרים את זה״."),

    ("receipts", "4 · המילים שהיא אומרת בכל תור, ואף פעם לא הקשבנו להן",
     "<code>אוקיי</code> ו-<code>בסדר</code> נאמרות כמעט בכל תור של כל שיחה מאז שהפיצ׳ר עלה לאוויר, "
     "ומעולם לא נבדקו בהאזנה. <code>הבנתי אותךָ</code> ו-<code>טוב, הבנתי</code> נשפטו ב-31.8 על "
     "<b>תדירות</b> (״נאמר יותר מדי פעמים״) והועברו למצב ״רק כשהלקוח באמת שיתף משהו״ — אבל גם הן "
     "מעולם לא נשפטו על <b>צליל</b>.<br><br>"
     "כאן יש קליפ אחד לכל אחת, והשאלה היא רק ״זה נשמע טוב?״. אם משהו צורם — סמן ״לא טוב״ ותכתוב "
     "מה שמעת."),

    ("nod", "5 · ההנהון באמצע הכתבת מספר",
     "כשאתה מקריא מספר טלפון או כתובת מייל היא לא אמורה להגיד משפט שלם — היא אמורה להנהן ולתת לךָ "
     "להמשיך. <b>אלה הקליפים היחידים בעמוד שנאמרים לבד</b>, כי ככה זה קורה בפועל. "
     "אם אחד מהם נשמע כמו מילה ולא כמו הנהון, הוא נכשל."),
]


NIQQUD_CHARS = "".join(chr(c) for c in range(0x0591, 0x05C8))
PUNCT = " .,:;?!־-…׳״\"'"


def _norm(s: str) -> str:
    """Comparison key: no niqqud, no punctuation, no spaces. Only the letters survive."""
    return "".join(ch for ch in s if ch not in PUNCT and ch not in NIQQUD_CHARS)


def split_off_carrier(heard: str, carrier: str) -> tuple[str, bool]:
    """
    What the machine heard for the CANDIDATE WORD, and whether it heard anything at all.

    Returns (what_it_heard_for_the_word, survived). With no carrier (the nod) the whole transcript
    is the word. When the carrier is present, everything before it is the word — and an empty
    "before" means the interjection was destroyed by the 8kHz band even though the sentence after it
    came back perfectly. That is exactly what happened to `אההה` on the first run of this round, and
    it is invisible in a raw transcript.
    """
    if not carrier:
        return heard.strip(), _norm(heard) != ""
    key = _norm(carrier)
    hn = _norm(heard)
    idx = hn.find(key)
    if idx == -1:
        # The carrier itself came back mangled — nothing to subtract, so report the lot and let the
        # ear arbitrate. Never claim a survival we cannot locate.
        return heard.strip(), True
    # Walk the ORIGINAL string until `idx` normalised characters have gone past, so the returned
    # prefix keeps its real spelling and punctuation instead of the comparison key's.
    seen = 0
    cut = 0
    for i, ch in enumerate(heard):
        if seen >= idx:
            cut = i
            break
        if ch not in PUNCT and ch not in NIQQUD_CHARS:
            seen += 1
        cut = i + 1
    prefix = heard[:cut].strip(PUNCT)
    return prefix, _norm(prefix) != ""


def load_heard() -> dict:
    """Round-trip transcripts from roundtrip10.ts, if it has been run. Absent on a first build."""
    path = os.path.join(HERE, "round10-heard.json")
    if not os.path.exists(path):
        return {}
    return json.load(open(path, encoding="utf-8"))


HEARD = load_heard()


def main() -> None:
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    print(f"round-trip transcripts: {len(HEARD)}")
    manifest = {
        "model": synthmod.MODEL,
        "generation_config": synthmod.GENERATION_CONFIG,
        "cards": [],
    }
    for cid, section, word, variants, hear, score in CARDS:
        card = {
            "id": cid, "section": section, "word": word, "hear": hear, "score": score,
            # Read by roundtrip10.ts as well as by this file's page builder — one definition.
            "carrier": CARRIER_OF_SECTION.get(section, ""),
            "variants": [],
        }
        for key, label, text in variants:
            fname = f"r10_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            # Existing clips are kept, like rounds 6–9: his ear and any later analysis must judge
            # the SAME audio. Delete a wav (or pass --resynth) to regenerate it.
            if "--resynth" in sys.argv or not os.path.exists(path):
                synth(text, path)
            variant = {
                "key": key, "label": label, "text": text, "file": fname, "dur": round(dur(path), 2)
            }
            if f"{cid}_{key}" in HEARD:
                variant["heard"] = HEARD[f"{cid}_{key}"]
            card["variants"].append(variant)
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(
        manifest,
        open(os.path.join(HERE, "round10.json"), "w", encoding="utf-8"),
        ensure_ascii=False,
        indent=2,
    )
    print("wrote round10.json")
    write_page(manifest)


def variant_html(cid: str, v: dict, carrier: str = "") -> str:
    # What Soniox got back off this exact clip through an 8kHz round trip (roundtrip10.ts). Shown
    # UNDER the audio and labelled for what it is: evidence that the sound SURVIVED the line, never
    # evidence that it was pronounced well. For an interjection the machine has no useful opinion at
    # all — but an EMPTY transcript is a hard fact, and it is the failure that erased "אוו" in round
    # 4b with nobody noticing.
    heard = v.get("heard")
    heard_html = ""
    if heard is not None:
        word_heard, survived = split_off_carrier(heard, carrier)
        if not survived:
            heard_html = (
                '<div class="heard gone" dir="rtl"><span class="hlbl">מה שהמכונה שמעה דרך קו '
                "8kHz:</span><b>המילה נעלמה לגמרי.</b> המשפט שאחריה חזר במלואו, והמילה עצמה לא "
                "הגיעה בכלל. זה בדיוק מה שקרה ל״אוו״ בסבב 4b.</div>"
            )
        else:
            cls = "heard same" if _norm(word_heard) == _norm(v["text"].split()[0]) else "heard diff"
            heard_html = (
                f'<div class="{cls}" dir="rtl"><span class="hlbl">מה שהמכונה שמעה דרך קו 8kHz '
                f'(רק ״שרד את הקו״ — לא ״נשמע טוב״):</span>'
                f'<b>{htmlmod.escape(word_heard)}</b>'
                f'<span class="full">— מהקליפ כולו: {htmlmod.escape(heard.strip())}</span></div>'
            )
    return f"""
      <div class="col">
        <div class="vhead"><span class="vkey">{v['key']}</span>
          <span class="vlabel">{htmlmod.escape(v['label'])}</span>
          <span class="tag">{v.get('dur', '?')}s</span></div>
        <div class="he" dir="rtl">{htmlmod.escape(v['text'])}</div>
        <audio controls preload="none" src="{v['file']}"></audio>
        {heard_html}
        <div class="psrow">
          <label class="lbl"><input type="radio" name="pick_{cid}" value="{v['key']}"> זה הכי טוב</label>
        </div>
      </div>"""


def card_html(c: dict) -> str:
    cols = "".join(variant_html(c["id"], v, c.get("carrier", "")) for v in c["variants"])
    n = len(c["variants"])
    last = "לא טוב — להוריד מהבנק" if n == 1 else ("שניהם לא טובים" if n == 2 else "אף אחת לא טובה")
    return f"""
    <div class="card" data-id="{c['id']}">
      <div class="chead"><span class="cid">{htmlmod.escape(c['word'])}</span>
        <span class="tag">{c['id']}</span></div>
      <div class="cols">{cols}</div>
      <div class="psrow">
        <label class="lbl none"><input type="radio" name="pick_{c['id']}" value="none"> {last}</label>
        <input type="text" class="note" name="note_{c['id']}" dir="rtl" placeholder="מה שמעת?">
      </div>
    </div>"""


def findings_html(data: dict) -> str:
    """
    What the MACHINE already settled, before he plays a single clip.

    Two things a transcriber can say about an interjection, and only two — but both are hard facts
    and both change which options are worth listening to:

      · the candidate never came back at all (the round-4b `אוו` failure)
      · the candidate came back as something with none of its letters in it, i.e. the line turned
        the sound into a DIFFERENT word

    The second one is why this box exists at all. On the first run `אהההה` — the spelling Koren
    himself proposed — came back as `חח`, which in Hebrew chat is laughter. That is not a verdict on
    how it sounds, and he may still prefer it; but he should know before he chooses.

    Everything else on this page is his.
    """
    gone, wrong = [], []
    for c in data["cards"]:
        carrier = c.get("carrier", "")
        for v in c["variants"]:
            if "heard" not in v:
                continue
            word_heard, survived = split_off_carrier(v["heard"], carrier)
            sent_word = v["text"].split()[0]
            if not survived:
                gone.append((c["id"], v["key"], sent_word))
            elif not (set(_norm(word_heard)) & set(_norm(sent_word))):
                wrong.append((c["id"], v["key"], sent_word, word_heard))
    if not gone and not wrong:
        return ""

    rows = []
    for cid, key, sent in gone:
        rows.append(
            f"<li><code>{cid}_{key}</code> — <b>{htmlmod.escape(sent)}</b> לא חזרה מהקו בכלל. "
            "המשפט שאחריה חזר מושלם; המילה עצמה נעלמה.</li>"
        )
    for cid, key, sent, got in wrong:
        rows.append(
            f"<li><code>{cid}_{key}</code> — <b>{htmlmod.escape(sent)}</b> חזרה בתור "
            f"<b>{htmlmod.escape(got)}</b>, בלי אף אות משותפת. הקו הפך את הצליל למילה אחרת.</li>"
        )
    return (
        '<div class="lede warn"><b>מה שהמכונה כבר סגרה, לפני שתקשיב:</b> אלה שתי העובדות היחידות '
        "שתמלול יכול לתת על הברה, ושתיהן קשות.<ul>" + "".join(rows) + "</ul>"
        "האפשרויות האלה נשארות בעמוד ואפשר לבחור בהן — אבל תדע מה אתה בוחר. כל השאר הוא שלךָ.</div>"
    )


def write_page(data: dict) -> None:
    body = []
    for key, title, sub in GROUPS:
        cards = [c for c in data["cards"] if c["section"] == key]
        if not cards:
            continue
        body.append(f'<h2>{title}</h2><p class="sub">{sub}</p>' + "".join(card_html(c) for c in cards))

    model = htmlmod.escape(data["model"])
    gc = data.get("generation_config") or {}
    gctxt = f"speed {gc.get('speed', 1)} · volume {gc.get('volume', 1)}"
    findings = findings_html(data)

    page = f"""<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>סבב 10 · מילות המילוי · {model}</title>
<style>
  :root {{ --bg:#0e1116; --card:#171b22; --line:#252b36; --txt:#e6e9ef; --dim:#9aa4b2;
           --acc:#3b82f6; --warn:#f59e0b; --bad:#ef4444; }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--txt); font-family:"Segoe UI",Arial,sans-serif; }}
  header, main {{ max-width:1100px; margin:0 auto; padding:0 20px; }}
  header {{ padding-top:26px; }}
  h1 {{ margin:0 0 6px; font-size:22px; }}
  h2 {{ font-size:18px; margin:34px 0 2px; }}
  .sub {{ color:var(--dim); font-size:14px; margin:4px 0 10px; line-height:1.6; }}
  .lede {{ background:#171b22; border:1px solid var(--line); border-inline-start:3px solid var(--acc);
           border-radius:10px; padding:14px 16px; margin:14px 0 6px; font-size:14px;
           line-height:1.65; color:#cbd3de; }}
  .lede.warn {{ border-inline-start-color:var(--warn); }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin:14px 0; }}
  .chead {{ display:flex; align-items:center; gap:10px; margin-bottom:10px; }}
  .cid {{ font-weight:700; font-size:19px; }}
  .tag {{ font-size:12px; color:var(--dim); font-family:monospace; }}
  .cols {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:10px; }}
  .col {{ border:1px solid var(--line); border-radius:10px; padding:12px; background:#0f131a; }}
  .col:has(input:checked) {{ border-color:var(--acc); }}
  .vhead {{ display:flex; align-items:center; gap:8px; margin-bottom:6px; }}
  .vkey {{ font-family:monospace; font-weight:700; color:var(--acc); }}
  .vlabel {{ font-size:13px; color:var(--dim); }}
  .lbl {{ font-size:13px; color:var(--dim); display:inline-flex; align-items:center; gap:6px; cursor:pointer; }}
  .none {{ color:#e0a0a0; }}
  .he {{ font-size:19px; margin-bottom:8px; line-height:1.5; }}
  audio {{ width:100%; height:34px; }}
  .heard {{ margin-top:8px; font-size:13px; line-height:1.5; border-radius:8px; padding:7px 9px;
            background:#0b0e13; border:1px solid var(--line); }}
  .heard.same {{ color:#8fb99a; }}
  .heard.diff {{ color:#e6b980; border-color:#4a3a22; }}
  .heard.gone {{ color:#ffb4b4; border-color:var(--bad); }}
  .hlbl {{ color:var(--dim); font-size:12px; display:block; margin-bottom:2px; }}
  .full {{ color:var(--dim); font-size:12px; display:block; margin-top:3px; }}
  .psrow {{ display:flex; gap:14px; align-items:center; margin-top:10px; flex-wrap:wrap; }}
  .note {{ flex:1; min-width:220px; background:#0e1116; border:1px solid var(--line); border-radius:8px;
           color:var(--txt); padding:8px 10px; font-size:14px; }}
  table.scr {{ border-collapse:collapse; width:100%; margin-top:8px; font-size:13px; }}
  table.scr td, table.scr th {{ border:1px solid var(--line); padding:6px 9px; text-align:right; }}
  table.scr th {{ color:var(--dim); font-weight:600; }}
  .no {{ color:#ffb4b4; }} .yes {{ color:#8fb99a; }}
  #summary {{ width:100%; min-height:220px; background:#0f131a; color:var(--txt); border:1px solid var(--line);
              border-radius:10px; padding:12px; font-family:monospace; font-size:13px; direction:ltr; }}
  button {{ background:var(--acc); border:0; color:#fff; border-radius:8px; padding:10px 18px;
            font-size:14px; cursor:pointer; margin:10px 0; }}
</style>
</head>
<body>
<header>
  <h1>סבב 10 — מילות המילוי והקבלה ({model}, {gctxt})</h1>
  <div class="lede">
    ביקשת את המבחן הזה ב-30.8: <b>״מילות המילוי נאמרות באופן מוזר, במקום להגיד אהה הסוכן אומר
    אוהה או אההא, צריך שתיצור לי מבחן קולי ואבחר אופציות נכונות״</b>. הוא נבנה באותו יום, ולא
    יכולת לנגן בו אף קליפ — כל ההקלטות בסבבים 1-8 נכתבו עם כותרת WAV שבורה. לכן האיות מעולם לא
    נבחר, ו-<code>אהה</code> נשאר בבנק בדיוק כמו שהיה ונאמר בכל שיחה מאז. אתמול אמרת את זה שוב:
    <b>״היא אומרת 'או-ה' במקום 'אהההה' אחיד״</b>.<br><br>
    <b>אני לא משנה כאן שום איות.</b> העמוד מציג אפשרויות; האוזן שלךָ בוחרת ואני מיישם אחר כך.
    סמן מה עדיף, ובסוף ״צור סיכום״ והדבק לי בחזרה.
  </div>

  <div class="lede warn">
    ⚠️ <b>״התמלול תקין״ זה לא ״ההגייה תקינה״, וזה כל העניין של הסבב הזה.</b><br>
    בכל סבב עד היום בדקנו מילה בכך שהעברנו אותה דרך קו 8kHz וראינו שהמכונה מחזירה אותה נכון. זה
    תופס מילה שהקו הורס (״נוח״ שחוזר ״נח״), וזה שימושי. <b>זה לא יכול לתפוס מילה שחוזרת מושלם
    ונשמעת רע בדרך</b> — סוניוקס תכתוב ״אהה״ בין אם קרטזיה אמרה צליל אחד רציף ובין אם אמרה
    ״או-ה״ עם עצירה באמצע, כי זאת אותה מילה. ככה <code>אהה</code> הגיע לפרודקשן בלי שאף אחד שמע
    אותו.
    <table class="scr">
      <tr><th>מה</th><th>נשמע בהאזנה?</th><th>הערה</th></tr>
      <tr><td><code>אהה. אוקיי. בסדר.</code></td><td class="no">לא. אף פעם.</td>
          <td>בנק הקבלות — נאמרות כמעט בכל תור של כל שיחה</td></tr>
      <tr><td><code>הבנתי אותךָ. טוב, הבנתי.</code></td><td class="no">לא</td>
          <td>נשפטו על תדירות ב-31.8 בלבד, לא על צליל</td></tr>
      <tr><td><code>אממ... רגע... שנייה... אה...</code></td><td class="no">לא. אף פעם.</td>
          <td>בנק ההיסוסים — מעולם לא עבר שום בדיקה</td></tr>
      <tr><td><code>אה אה.</code></td><td class="no">לא</td>
          <td>ההנהון — סבב 6 הציע 5 איותים, אף אחד לא נשפט</td></tr>
      <tr><td><code>שלךָ · לךָ · אותךָ · אליךָ · איתכה</code></td><td class="yes">כן</td>
          <td>סבבים 3 / 3b / 3c — אוזן + round trip</td></tr>
      <tr><td><code>לוודֵא · רוצֶה · רוצָה</code></td><td class="yes">כן</td>
          <td>סבב 3, ונבדק שוב בסבב 6</td></tr>
    </table>
  </div>

  {findings}

  <p class="sub">
    כל ההקלטות סונתזו במהירות ובעוצמה של הפרודקשן (0.9 / 1.4) ובאותו דגם, והכותרת של כל קובץ
    נבדקה אחרי הכתיבה. מתחת לכל קליפ מופיע מה שהמכונה שמעה ממנו בחזרה דרך קו 8kHz — כדעה שנייה
    על <b>שרידות</b>, לא על הגייה. <b>תמלול ריק</b> מסומן באדום: זאת עובדה קשה, וזאת התקלה
    שהעלימה את ״אוו״ בסבב 4b בלי שאיש שם לב.
  </p>
</header>
<main>
{''.join(body)}
<h2>סיכום</h2>
<button id="btn">צור סיכום</button>
<textarea id="summary" readonly placeholder="הסיכום יופיע כאן"></textarea>
</main>
<script>
const KEY = 'r10-verdicts';
const state = JSON.parse(localStorage.getItem(KEY) || '{{}}');
document.querySelectorAll('input').forEach(el => {{
  if (el.type === 'radio' && state[el.name] === el.value) el.checked = true;
  if (el.type === 'text' && state[el.name]) el.value = state[el.name];
  el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {{
    state[el.name] = el.value;
    localStorage.setItem(KEY, JSON.stringify(state));
  }});
}});
document.getElementById('btn').addEventListener('click', () => {{
  const lines = ['round10 verdicts ({model})'];
  document.querySelectorAll('.card').forEach(card => {{
    const id = card.dataset.id;
    const pick = state['pick_' + id] || '-';
    const note = state['note_' + id] ? '  note: ' + state['note_' + id] : '';
    lines.push(id + ': ' + pick + note);
  }});
  const box = document.getElementById('summary');
  box.value = lines.join('\\n');
  box.select();
}});
</script>
</body>
</html>"""
    open(os.path.join(HERE, "index-round10.html"), "w", encoding="utf-8").write(page)
    print("wrote index-round10.html")


if __name__ == "__main__":
    main()
