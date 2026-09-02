"""
Round 20 — `מספר`, the word that is two words.

Koren, 2026-09-02: *"אם הוא מתכוון להגיד מספר בהקשרים של מספר כלשהו (1,2,3) אז צריך חיריק; אם זה
'מספר' כמו 'מישהו מספר סיפור' אז אין צורך בחיריק ויש צורך לנקד את המילה."*

    מִסְפָּר   mispar    a number
    מְסַפֵּר   mesaper   he tells

Same four letters. Hebrew writes no vowels, so Cartesia guesses — the identical failure mode as
`שלך` (le-KHA / lakh) and `רוצה` (rotsE / rotsA), both of which were fixed one word at a time in
this experiment and neither of which was fixed by theory.

WHAT MAKES THIS ONE DIFFERENT, and why it is a separate card per sense rather than one row: the
other fixes were one spelling → one pronunciation. This word needs the CONTEXT to decide which
pronunciation is even correct, so whatever wins here becomes a conditional rule, not a
substitution. The number sense dominates her actual speech — 32 agent lines in the whole call
corpus contain `מספר` and the sampled ones are all "number" — which means the safe default is the
number reading and the narrating sense is the exception that needs detecting.

⚠️ THE ROUND-TRIP CANNOT ANSWER THIS ONE EITHER, for exactly the reason round 15 could not answer
`נוח`: both readings are the same four letters, so Soniox writes `מספר` whichever she says. It is
run anyway, and it can answer only ONE question — whether a pointing breaks the word so badly that
it comes back as something else. Anything past that is his ear.
"""
import json, os, struct, sys, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod
import wavcheck

synthmod.MODEL = "sonic-3.5"
synthmod.GENERATION_CONFIG = {"speed": 0.9, "volume": 1.4}

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

CARDS = [
    ("m1", "מספר = number, במשפט שהיא באמת אמרה",
     'מהשיחה של 10:53: הוא שאל אם לסוכן יש קו טלפון. זה השימוש הנפוץ ביותר של המילה אצלה.',
     [
         ("A", "היום — בלי ניקוד", "זה מספר שהלקוחות מתקשרים אליו, והסוכן עונה להם כמו נציג."),
         ("B", "חיריק על המ״ם בלבד", "זה מִספר שהלקוחות מתקשרים אליו, והסוכן עונה להם כמו נציג."),
         ("C", "ניקוד מלא", "זה מִסְפָּר שהלקוחות מתקשרים אליו, והסוכן עונה להם כמו נציג."),
         ("D", "לוותר על המילה", "זה קו שהלקוחות מתקשרים אליו, והסוכן עונה להם כמו נציג."),
     ]),
    ("m2", "מספר הטלפון — הצירוף שחוזר בכל שיחה",
     'הצירוף הזה מופיע ב-32 מהמשפטים שלה בכל אוסף השיחות. אם משנים משהו, זה המקום שבו זה יישמע הכי הרבה.',
     [
         ("A", "היום — בלי ניקוד", "מה מספר הטלפון שלךָ?"),
         ("B", "חיריק על המ״ם בלבד", "מה מִספר הטלפון שלךָ?"),
         ("C", "ניקוד מלא", "מה מִסְפָּר הטלפון שלךָ?"),
     ]),
    ("m3", "מספר = מספר סיפור — המשמעות השנייה",
     'נדיר אצלה, אבל קיים: כשהיא מדברת על מה שהלקוח מספר לה. כאן ההגייה הנכונה היא ההפוכה.',
     [
         ("A", "היום — בלי ניקוד", "כשלקוח מספר לךָ מה הוא צריך, הסוכן שומע את זה ורושם."),
         ("B", "צירה על הפ״א בלבד", "כשלקוח מספֵּר לךָ מה הוא צריך, הסוכן שומע את זה ורושם."),
         ("C", "ניקוד מלא", "כשלקוח מְסַפֵּר לךָ מה הוא צריך, הסוכן שומע את זה ורושם."),
     ]),
    ("d1", "דמו — המילה שהיא אומרת בכל סגירה",
     'זו המילה שבה נגמרת כמעט כל שיחה ("שיחת דמו עם קורן"). בלי ניקוד היא יכולה לצאת דָּמוֹ — '
     'כלומר "הדם שלו" — ולא Demo.',
     [
         ("A", "היום — בלי ניקוד", "שיחת הדמו עם קורן היא המקום שבו רואים בדיוק מה מקבלים."),
         ("B", "סגול על הדל״ת", "שיחת הדֶמו עם קורן היא המקום שבו רואים בדיוק מה מקבלים."),
         ("C", "סגול וחולם", "שיחת הדֶמוֹ עם קורן היא המקום שבו רואים בדיוק מה מקבלים."),
         ("D", "באנגלית בתוך המשפט", "שיחת ה-demo עם קורן היא המקום שבו רואים בדיוק מה מקבלים."),
         ("E", "הדגמה — המילה העברית", "שיחת ההדגמה עם קורן היא המקום שבו רואים בדיוק מה מקבלים."),
     ]),
    ("d2", "דמו במשפט ההצעה עצמו",
     'המשפט שבו היא מבקשת את הפגישה. אותה מילה, מיקום אחר — ומילה בסוף משפט נשמעת אחרת ממילה באמצעו.',
     [
         ("A", "היום — בלי ניקוד", "אם תרצה, אפשר לקבוע דמו קצר עם קורן."),
         ("B", "סגול על הדל״ת", "אם תרצה, אפשר לקבוע דֶמו קצר עם קורן."),
         ("C", "סגול וחולם", "אם תרצה, אפשר לקבוע דֶמוֹ קצר עם קורן."),
         ("D", "הדגמה", "אם תרצה, אפשר לקבוע הדגמה קצרה עם קורן."),
     ]),
]


def to_phone(src_path, out_path):
    """8kHz box-average downsample — the same crude low-pass as testing/wav.ts toPhoneRate."""
    with wave.open(src_path, "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    if width != 2:
        raise SystemExit(f"{src_path}: expected 16-bit PCM, got {width * 8}-bit")
    pcm = struct.unpack(f"<{len(raw) // 2}h", raw)
    if channels == 2:
        pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
    ratio = rate / PHONE_RATE
    out = []
    for i in range(int(len(pcm) / ratio)):
        start, end = int(i * ratio), min(int((i + 1) * ratio), len(pcm))
        window = pcm[start:end] or [0]
        out.append(int(round(sum(window) / len(window))))
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(PHONE_RATE)
        w.writeframes(struct.pack(f"<{len(out)}h", *out))
    wavcheck.assert_playable(out_path)


def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}
    for cid, title, note, variants in CARDS:
        card = {"id": cid, "title": title, "note": note, "variants": []}
        for key, label, text in variants:
            stem = f"r20_{cid}_{key}"
            studio = os.path.join(HERE, f"{stem}.wav")
            synthmod.synth(text, studio)
            wavcheck.assert_playable(studio)
            to_phone(studio, os.path.join(HERE, f"{stem}_phone.wav"))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": f"{stem}.wav", "phone": f"{stem}_phone.wav"})
            print(f"  {stem}  ok  (+phone)")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round20.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round20.json")


if __name__ == "__main__":
    main()
