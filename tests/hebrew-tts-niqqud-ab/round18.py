"""
Round 18 — the pause where the code will actually put it, on the sentences it will actually say.

Rounds 16 and 17 asked isolated questions: does the tag work, how long, where does it belong.
This one asks the only question left before the feature is trusted — **does it sound right in the
sentences she really speaks?** So every line here is lifted from the live prompt or from a tool's
own filler text, not written for a page.

FOUR OF THE SIX CARDS ARE NEGATIVE CONTROLS, and that is deliberate. Koren's round-17 note was as
much about where the pause does NOT belong ("לא בדברים פשוטים או בכל משפט") as about where it
does, and a page that only demonstrates the good cases cannot tell you whether the rule is right.
`nc` and `ng` put a pause exactly where the prompt forbids one. If they sound fine, the rule is
too strict and we are spending a beat we could keep; if they sound wrong, the rule is doing work.

  ca  the calendar check — 0.25s. The tool's own filler line, verbatim.
  pr  the price question — 0.15s after the filler, mid-sentence. The pricing ladder's first step.
  em  the empathy moment — 0.35s. The sentence he approved on round 16 card em.
  nc  NEGATIVE: a simple confirmation with a pause the prompt forbids.
  ng  NEGATIVE: the greeting with a pause the prompt forbids.
  bk  the booking read-back — a place nobody has tested, where a beat could either help him hear
      the time or make her sound unsure about a fact she is certain of.

PHONE BAND ONLY. This page is going on his phone, over whatever connection he has, and the 8kHz
clip is the one that decides anyway — a pause reads as a pause in the phone band and as studio
silence at 44.1kHz. Half the bytes, and the half that matters.

  python tests/hebrew-tts-niqqud-ab/round18.py
"""
import base64, json, os, struct, sys, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod
import wavcheck

synthmod.MODEL = "sonic-3.5"
synthmod.GENERATION_CONFIG = {"speed": 0.9, "volume": 1.4}

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

CARDS = [
    ("ca", "1 · בדיקת יומן", "0.25 שניות",
     "המשפט הזה הוא הטקסט האמיתי של הכלי — היא אומרת אותו בכל פעם שבדיקת היומן לוקחת יותר מחצי שנייה. זה המקום שהקוד יודע עליו בוודאות.",
     "רגע, אני בודקת את היומן.",
     'רגע <break time="0.25s"/> אני בודקת את היומן.'),
    ("pr", "2 · שאלת המחיר", "0.15 שניות",
     "השלב הראשון בסולם המחיר. שאלה שדורשת מחשבה — ולכן ההיסוס באמצע המשפט, לא בהתחלה.",
     "המחיר נקבע לפי כמה שיחות הסוכן מנהל בשבילךָ. כמה פניות נכנסות אליךָ בחודש?",
     'המחיר, אֶה <break time="0.15s"/> נקבע לפי כמה שיחות הסוכן מנהל בשבילךָ. כמה פניות נכנסות אליךָ בחודש?'),
    ("em", "3 · הרגע האמפתי", "0.35 שניות",
     "אחרי שהוא אמר משהו שעולה לו. זה המשפט שבחרת בסבב 16.",
     "אני מבינה. זה באמת מתסכל.",
     'אני מבינה <break time="0.35s"/> זה באמת מתסכל.'),
    ("nc", "4 · ⚠️ בקרה שלילית — אישור פשוט", "0.25 שניות",
     "כאן הפרומפט אוסר פאוזה במפורש. B הוא מה שיקרה אם הכלל לא יחזיק. אם B נשמע לךָ בסדר — הכלל מחמיר מדי ואפשר להרפות; אם הוא נשמע כמו מישהו שמעמיד פנים שהוא חושב על כלום, הכלל עובד.",
     "בטח, אני רושמת את זה.",
     'בטח <break time="0.25s"/> אני רושמת את זה.'),
    ("ng", "5 · ⚠️ בקרה שלילית — הפתיחה", "0.35 שניות",
     "אותו דבר, על המשפט הראשון בשיחה. פאוזה כאן היא הדבר שהכי מהר נשמע מזויף, ולכן היא אסורה.",
     "שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales.",
     'שלום <break time="0.35s"/> מדברת קרן, העוזרת הדיגיטלית של ClickScales.'),
    ("bk", "6 · הקראת הפגישה שנקבעה", "0.25 שניות",
     "מקום שאף אחד לא בדק. פאוזה לפני השעה יכולה לעזור לו לקלוט אותה — או לגרום לה להישמע לא בטוחה בעובדה שהיא כן בטוחה בה. אין כאן תשובה נכונה מראש.",
     "קבעתי לךָ פגישה ליום שלישי בשתיים וחצי.",
     'קבעתי לךָ פגישה ליום שלישי <break time="0.25s"/> בשתיים וחצי.'),
]


def to_phone(src_path, out_path):
    """8kHz box-average — the same crude low-pass as the repo's own toPhoneRate."""
    with wave.open(src_path, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit(f"{src_path}: expected 16-bit PCM, got {width * 8}-bit")
    pcm = list(struct.unpack(f"<{len(raw) // 2}h", raw))
    if ch == 2:
        pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
    ratio = rate / PHONE_RATE
    out = []
    for i in range(int(len(pcm) / ratio)):
        start, end = int(i * ratio), min(int((i + 1) * ratio), len(pcm))
        window = pcm[start:end] or [0]
        out.append(int(round(sum(window) / len(window))))
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(PHONE_RATE)
        w.writeframes(struct.pack(f"<{len(out)}h", *out))
    wavcheck.assert_playable(out_path)


def render(text, stem):
    studio = os.path.join(HERE, f"{stem}__studio.wav")
    phone = os.path.join(HERE, f"{stem}_phone.wav")
    synthmod.synth(text, studio)
    wavcheck.assert_playable(studio)
    to_phone(studio, phone)
    os.unlink(studio)          # the page is phone-band only; the studio clip is a byte tax
    return phone


def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    total = 0
    for cid, title, length, note, a_text, b_text in CARDS:
        card = {"id": cid, "title": title, "length": length, "note": note, "variants": []}
        for key, text in (("A", a_text), ("B", b_text)):
            path = render(text, f"r18_{cid}_{key}")
            # Base64 inline, because the page has to work on his phone with no local files and no
            # server. Phone-band mono at 8kHz keeps a 3-second clip around 50KB before encoding.
            b64 = base64.b64encode(open(path, "rb").read()).decode("ascii")
            total += len(b64)
            card["variants"].append({
                "key": key,
                "text": text,
                "wav": f"data:audio/wav;base64,{b64}",
                "bytes": os.path.getsize(path),
            })
            print(f"  r18_{cid}_{key}  {os.path.getsize(path) // 1024}KB")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round18.json"), "w", encoding="utf-8"),
              ensure_ascii=False)
    print(f"wrote round18.json  (~{total // 1024}KB of base64 audio)")


if __name__ == "__main__":
    main()
