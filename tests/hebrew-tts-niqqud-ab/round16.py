"""
Round 16 — RHYTHM. The first round about how fast she talks rather than how she spells things.

Koren, 2026-09-02, after the voice-modes A/B: *"היא עדיין נשמעת קצת רובוטית אבל זה בהחלט שיפור,
ומפה אפשר להמשיך לחדד."* And then: *"צריך עוד טסטים."*

WHY THE CALL A/B COULD NOT ANSWER THIS, and why this page exists instead. `npm run voice:ab:call`
runs each variant as a SEPARATE live call, so the model writes DIFFERENT SENTENCES in each one.
Comparing them compares wording and delivery at the same time, and wording wins every time — he
picked B on two turns and could not judge the other six because the clips no longer lined up with
the labels. Here every variant of a card is the SAME TEXT, so the only thing that changes is the
thing being tested. That is the whole difference between a listening round and a demo.

  sp  THE RATE ITSELF. Four speeds of one sentence. The shipped hesitant setting is 0.78 and it
      was picked from a duration table (known-issues §9), not from an ear. This is the ear.
  tr  THE TRANSITION, which is Koren's actual question. In production the rate changes BETWEEN
      turns, never inside one — so each clip here is two sentences synthesized separately and
      joined, exactly as the caller would hear them. A is both at production speed; B and C drop
      the second one. Does it sound like a person slowing down, or like a gear change?
  br  <break time="…"/>. THE BIGGEST UNTESTED LEVER IN THE STACK. Measured on 2026-08-30 as the
      longest pause available (780ms streamed vs 180ms for a comma) AND absent from the Soniox
      round-trip, i.e. apparently not read aloud — but never once judged by ear, so it was
      recorded in known-issues §16 and deliberately not shipped. If a silently-ignored tag were
      read out to a caller that is the worst failure mode in this file, which is exactly why it
      belongs on a page and not in a deploy. LISTEN FOR A SPOKEN "BREAK" BEFORE ANYTHING ELSE.
  em  THE EMPATHETIC BEAT. The empathetic register deliberately gets NO speed change — anything
      between 0.85 and 1.0 is inside the engine's own noise — so its whole mechanism is the pause
      after the acknowledgement. Which mark buys it: comma, full stop, or ellipsis?
  df  DISFLUENCY INSIDE A REPLY. We have hesitation BEFORE a reply and nothing inside one
      (phase-7 W2, never built). Every token here is unscreened, which is the point: an unscreened
      Hebrew interjection fails SILENTLY — `חח` came out as the letter khet and `אוו` vanished —
      so nothing from this card goes near the code until it has been heard.

EVERY VARIANT IS RENDERED TWICE: `<id>.wav` at 44.1kHz and `<id>_phone.wav` box-averaged to 8kHz.
The phone clip decides. Pacing judged on studio audio is pacing judged on a call that never happens.

  python tests/hebrew-tts-niqqud-ab/round16.py
  python tests/hebrew-tts-niqqud-ab/build_round16_page.py   # -> index-round16.html
"""
import json, os, struct, sys, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod
import wavcheck

# Production speaks sonic-3.5 at 0.9 / 1.4. A rhythm round at 1.0/1.0 would be a round about a
# voice nobody has ever heard.
synthmod.MODEL = "sonic-3.5"
BASE_VOLUME = 1.4
PRODUCTION_SPEED = 0.9

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

PITCH = "אנחנו דואגים שכל פנייה שנכנסת אליךָ תקבל שיחה תוך דקה."
CHECKING = "רגע, אני בודקת את היומן."

# (id, title, note, [(key, label, spec)])
# spec is either a string (one synthesis) or a list of (text, speed) pairs joined end to end.
CARDS = [
    ("sp", "1 · הקצב עצמו — כמה איטי זה \"מהוסס\"",
     "אותו משפט בדיוק, ארבע מהירויות. 0.90 זה מה שרץ היום. 0.78 זה מה שהקוד שולח עכשיו במצב "
     "\"מהססת\", והמספר הזה נבחר מטבלת משכים — לא מאוזן. זו האוזן. שים לב ש-1.00 ו-0.90 כמעט "
     "זהים במשך; אם הם נשמעים לך שונה, זה לא הקצב.",
     [
         ("A", "1.00 — מהיר", [(CHECKING, 1.0)]),
         ("B", "0.90 — הפרודקשן היום", [(CHECKING, 0.9)]),
         ("C", "0.78 — מה שנשלח כרגע כמהססת", [(CHECKING, 0.78)]),
         ("D", "0.72 — איטי מאוד", [(CHECKING, 0.72)]),
     ]),
    ("tr", "2 · המעבר — האם זה נשמע כמו אדם או כמו החלפת הילוך",
     "השאלה שלך. בפרודקשן הקצב מתחלף בין תור לתור, אף פעם לא בתוך משפט — לכן כל קליפ כאן הוא "
     "שני משפטים שסונתזו בנפרד והודבקו, בדיוק כמו שהלקוח היה שומע אותם. A: שניהם באותו קצב. "
     "B: השני יורד ל-0.78. C: השני יורד ל-0.72.",
     [
         ("A", "בלי מעבר — שניהם 0.90", [("בטח, אני אשמח לעזור.", 0.9), (CHECKING, 0.9)]),
         ("B", "מעבר ל-0.78", [("בטח, אני אשמח לעזור.", 0.9), (CHECKING, 0.78)]),
         ("C", "מעבר ל-0.72", [("בטח, אני אשמח לעזור.", 0.9), (CHECKING, 0.72)]),
     ]),
    ("br", "3 · תגית ההשהיה — הלֶבֶר הכי גדול שמעולם לא נבדק באוזן",
     "⚠️ תשמע קודם כול אם המילה \"break\" נאמרת בקול. אם כן — הקלף הזה מת ואומרים את זה. "
     "המדידה מ-30.8 אומרת שהתגית מכובדת (780ms מול 180ms של פסיק) ושהיא לא נקראת בקול, אבל "
     "אף אחד לא שמע אותה. אם היא עובדת, זו ההשהיה הגדולה ביותר שיש לנו.",
     [
         ("A", "פסיק — מה שיש היום", [("תראה, בוא נעשה סדר, אני אסביר בדיוק איך זה עובד.", PRODUCTION_SPEED)]),
         ("B", "נקודה", [("תראה. בוא נעשה סדר. אני אסביר בדיוק איך זה עובד.", PRODUCTION_SPEED)]),
         ("C", "שלוש נקודות", [("תראה... בוא נעשה סדר... אני אסביר בדיוק איך זה עובד.", PRODUCTION_SPEED)]),
         ("D", "תגית 0.35 שניות", [('תראה <break time="0.35s"/> בוא נעשה סדר <break time="0.35s"/> אני אסביר בדיוק איך זה עובד.', PRODUCTION_SPEED)]),
         ("E", "תגית 0.6 שניות", [('תראה <break time="0.6s"/> בוא נעשה סדר <break time="0.6s"/> אני אסביר בדיוק איך זה עובד.', PRODUCTION_SPEED)]),
     ]),
    ("em", "4 · הפאוזה האמפתית — איזה סימן קונה אותה",
     "המצב האמפתי לא מקבל שינוי מהירות בכוונה: כל דבר בין 0.85 ל-1.0 נמצא בתוך רעש המנוע. "
     "לכן כל המנגנון שלו הוא הסימן שאחרי ההכרה. זה הרגע שאמרת עליו שהוא הליבה.",
     [
         ("A", "פסיק", [("אני מבינה, זה באמת מתסכל.", PRODUCTION_SPEED)]),
         ("B", "נקודה", [("אני מבינה. זה באמת מתסכל.", PRODUCTION_SPEED)]),
         ("C", "שלוש נקודות — מה שנשלח היום", [("אני מבינה... זה באמת מתסכל.", PRODUCTION_SPEED)]),
         ("D", "מקף", [("אני מבינה — זה באמת מתסכל.", PRODUCTION_SPEED)]),
     ]),
    ("df", "5 · חוסר שטף בתוך המשפט — לא לפניו",
     "היום יש לה היסוס רק בתחילת תשובה. אדם מהסס גם באמצע. כל אחד מהאיותים כאן לא עבר סינון "
     "מעולם, וכשלון של מילת ביניים בעברית הוא שקט — \"חח\" יצא כאות חית ו\"אוו\" נבלע. "
     "לכן זה קלף האזנה ולא קוד.",
     [
         ("A", "בלי — מה שיש היום", [(PITCH, PRODUCTION_SPEED)]),
         ("B", "התחלה מחדש עם מקף", [("אנחנו— אנחנו דואגים שכל פנייה שנכנסת אליךָ תקבל שיחה תוך דקה.", PRODUCTION_SPEED)]),
         ("C", "תיקון עצמי", [("אנחנו דואגים שכל פנייה — בעצם, כל פנייה שנכנסת אליךָ — תקבל שיחה תוך דקה.", PRODUCTION_SPEED)]),
         ("D", "\"אֶה\" באמצע", [("אנחנו דואגים שכל פנייה שנכנסת אליךָ, אֶה... תקבל שיחה תוך דקה.", PRODUCTION_SPEED)]),
     ]),
]


def read_pcm(path):
    with wave.open(path, "rb") as w:
        ch, width, rate, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit(f"{path}: expected 16-bit PCM, got {width * 8}-bit")
    pcm = list(struct.unpack(f"<{len(raw) // 2}h", raw))
    if ch == 2:
        pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
    return pcm, rate


def write_pcm(path, pcm, rate):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack(f"<{len(pcm)}h", *pcm))


def to_phone(src_path, out_path):
    """8kHz box-average — the same crude low-pass as the repo's own toPhoneRate.

    Plain decimation would alias and make every candidate sound equally bad, which would quietly
    invalidate the comparison this page exists for.
    """
    pcm, rate = read_pcm(src_path)
    ratio = rate / PHONE_RATE
    out = []
    for i in range(int(len(pcm) / ratio)):
        start, end = int(i * ratio), min(int((i + 1) * ratio), len(pcm))
        window = pcm[start:end] or [0]
        out.append(int(round(sum(window) / len(window))))
    write_pcm(out_path, out, PHONE_RATE)
    wavcheck.assert_playable(out_path)
    return out_path


def render(parts, stem):
    """Synthesize each (text, speed) part and join them.

    Joined rather than sent as one request BECAUSE THAT IS WHAT PRODUCTION DOES: Cartesia's speed
    is fixed for a whole synthesis stream, so a rate change can only ever happen between turns.
    Rendering it any other way would put a transition on the page that the agent cannot produce.

    The gap between parts is deliberately ZERO. The real gap is whatever the caller's own turn
    took, which is not a property of the delivery, and padding it would make every variant sound
    more spacious than it is.
    """
    pcms, rate = [], None
    for i, (text, speed) in enumerate(parts):
        piece = os.path.join(HERE, f"{stem}__p{i}.wav")
        synthmod.GENERATION_CONFIG = {"speed": speed, "volume": BASE_VOLUME}
        synthmod.synth(text, piece)
        wavcheck.assert_playable(piece)
        pcm, r = read_pcm(piece)
        rate = r if rate is None else rate
        if r != rate:
            raise SystemExit(f"{stem}: sample-rate mismatch {r} vs {rate}")
        pcms.extend(pcm)
        os.unlink(piece)
    out = os.path.join(HERE, f"{stem}.wav")
    write_pcm(out, pcms, rate)
    wavcheck.assert_playable(out)
    return out


def main():
    print(f"model: {synthmod.MODEL}  base volume: {BASE_VOLUME}")
    manifest = {"model": synthmod.MODEL, "volume": BASE_VOLUME, "cards": []}
    for cid, title, note, variants in CARDS:
        card = {"id": cid, "title": title, "note": note, "variants": []}
        for key, label, parts in variants:
            stem = f"r16_{cid}_{key}"
            studio = render(parts, stem)
            to_phone(studio, os.path.join(HERE, f"{stem}_phone.wav"))
            card["variants"].append({
                "key": key,
                "label": label,
                "text": " ⟶ ".join(t for t, _ in parts),
                "speeds": [s for _, s in parts],
                "file": f"{stem}.wav",
                "phone": f"{stem}_phone.wav",
            })
            print(f"  {stem}  ok  (+phone)  speeds={[s for _, s in parts]}")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round16.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round16.json")


if __name__ == "__main__":
    main()
