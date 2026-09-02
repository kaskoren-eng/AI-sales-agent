"""
Round 19 — the first half-second of her turn: which opener, and whether a lone filler is one.

Two of Koren's own observations from the 2026-09-02 10:53 call, which are really one question —
what does she say BEFORE she says anything.

  1. THE OPENERS. *"הסוכן נוטה להגיד בסדר או אוקי במקומות שלא באמת הגיוני… הייתי רוצה שהסוכן ישיב
     'כן..' כשהלקוח מבקש משהו או אומר משהו והסוכן מסכים איתו."* On that call she opened with
     `בסדר.` or `אוקי.` before ANSWERING YES — an acknowledgement standing in front of an
     agreement, which is two acknowledgements and no answer.

  2. THE LONE FILLER. Twice she emitted a hesitation as an entire turn. Traced: at 89s a 70-char
     reply was cancelled 0.5s in and only its opening filler reached the line; at 222s the MODEL
     genuinely produced a complete four-character turn (`charactersCount: 4, cancelled: false`)
     and the real answer came 1.6 seconds later. Card `f1` is the second case, rendered as he
     heard it — filler, real gap, then the answer — because the question is not whether `אמ.`
     sounds good but whether it is better than the silence it replaces.

EVERY LINE IS LIFTED FROM THAT CALL. `A` is always what she actually said, so a verdict of A is a
real answer ("leave it alone") and not a failure of the page to offer the status quo.

The `f1` clips are COMPOSED — two synthesised parts with real silence between them — because a
1.6-second gap is the whole subject of the card and no single utterance can carry it.
"""
import json, os, struct, sys, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod
import wavcheck

synthmod.MODEL = "sonic-3.5"
synthmod.GENERATION_CONFIG = {"speed": 0.9, "volume": 1.4}

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

# What she actually said at 131s, and the sentence every f1 variant ends with.
ANSWER_131 = "כן. הוא יכול לקבל את השיחות שנכנסות אליךָ ולענות מיד."

CARDS = [
    ("o1", "היא עונה כן — ומקדימה לזה אישור",
     'הוא שאל אם לסוכן יש קו טלפון שמתקשרים אליו. התשובה היא כן. היום היא פותחת ב"בסדר" ורק אז אומרת "כן".',
     [
         ("A", "היום — בסדר. כן.", "בסדר. כן. זה מספר שהלקוחות מתקשרים אליו, והסוכן עונה להם בשיחה כמו נציג."),
         ("B", "כן.. עם השהיה קלה", "כן.. זה מספר שהלקוחות מתקשרים אליו, והסוכן עונה להם בשיחה כמו נציג."),
         ("C", "כן, בהחלט", "כן, בהחלט. זה מספר שהלקוחות מתקשרים אליו, והסוכן עונה להם בשיחה כמו נציג."),
         ("D", "בלי שום פתיח", "זה מספר שהלקוחות מתקשרים אליו, והסוכן עונה להם בשיחה כמו נציג."),
     ]),
    ("o2", "הוא מבקש משהו והיא מסכימה",
     'הוא שאל אם זה יכול להתחבר למערכת ניהול המשלוחים שלו. זה בדיוק המקרה שתיארת — בקשה שהיא מסכימה לה.',
     [
         ("A", "היום — בסדר.", "בסדר. אם יש אצלך מערכת ניהול משלוחים, בדמו נבדוק בדיוק איך זה מתחבר לתהליך שלךָ."),
         ("B", "כן..", "כן.. אם יש אצלך מערכת ניהול משלוחים, בדמו נבדוק בדיוק איך זה מתחבר לתהליך שלךָ."),
         ("C", "בטח..", "בטח.. אם יש אצלך מערכת ניהול משלוחים, בדמו נבדוק בדיוק איך זה מתחבר לתהליך שלךָ."),
         ("D", "בלי שום פתיח", "אם יש אצלך מערכת ניהול משלוחים, בדמו נבדוק בדיוק איך זה מתחבר לתהליך שלךָ."),
     ]),
    ("o3", "מעבר לקביעת פגישה — אין פה למה להסכים",
     'כאן היא לא עונה ולא מסכימה, היא מתקדמת. השאלה אם "בסדר" עושה כאן משהו בכלל.',
     [
         ("A", "היום — בסדר.", "בסדר. נוֹחַ לךָ מחר, או שעדיף יום אחר?"),
         ("B", "בלי שום פתיח", "נוֹחַ לךָ מחר, או שעדיף יום אחר?"),
         ("C", "יופי — פתיח שמסמן התקדמות", "יופי. נוֹחַ לךָ מחר, או שעדיף יום אחר?"),
         ("D", "אז — מילת מעבר", "אז נוֹחַ לךָ מחר, או שעדיף יום אחר?"),
     ]),
    ("o4", "סלנג שנחת באמצע משפט תיאום",
     'מהשיחה של אתמול: "יש לי, סבבה, אחת עשרה פנויה". המילה נכונה בפני עצמה, השאלה אם המקום נכון.',
     [
         ("A", "היום — סבבה באמצע", "יש לי, סבבה, אחת עשרה פנויה — זה מתאים לךָ?"),
         ("B", "בלי הסלנג", "יש לי אחת עשרה פנויה — זה מתאים לךָ?"),
         ("C", "הסלנג בסוף, כהצעה", "יש לי אחת עשרה פנויה. מתאים לךָ?"),
     ]),
]

# f1 is composed, not synthesised in one piece: (spoken opener, silence, the answer).
COMPOSED = ("f1", "מילת מילוי לבדה — מול השקט שהיא מחליפה",
            'ככה זה נשמע בפועל: היא אומרת משהו קצר, ואז 1.6 שניות שקט, ואז התשובה. השאלה היא לא אם '
            '"אמ." נשמע טוב — אלא אם הוא עדיף על השקט שהוא בא במקומו.',
            [
                ("A", "היום — אמ. ואז שקט", "אמ.", 1.6),
                ("B", "אמ. רגע.. — מה שבחרת בסבב 11", "אמ. רֶגַע...", 1.6),
                ("C", "כלום — רק השקט ואז התשובה", None, 1.6),
            ])


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
    return out_path


def read_pcm(path):
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f"{path}: expected 16-bit PCM")
        raw = w.readframes(w.getnframes())
        pcm = list(struct.unpack(f"<{len(raw) // 2}h", raw))
        if w.getnchannels() == 2:
            pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
        return pcm, w.getframerate()


def compose(parts, out_path):
    """Join synthesised parts and silences into one clip. `parts` is a list of paths or float seconds.

    Every part must share a sample rate — they all come from the same Cartesia request shape, so
    they do, and the assert below is there for the day that stops being true rather than as
    decoration.
    """
    pcm, rate = [], None
    for part in parts:
        if isinstance(part, (int, float)):
            if rate is None:
                raise SystemExit("a composed clip may not begin with silence of unknown rate")
            pcm.extend([0] * int(rate * part))
            continue
        chunk, chunk_rate = read_pcm(part)
        if rate is None:
            rate = chunk_rate
        elif chunk_rate != rate:
            raise SystemExit(f"rate mismatch: {chunk_rate} vs {rate} in {part}")
        pcm.extend(chunk)
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(struct.pack(f"<{len(pcm)}h", *pcm))
    wavcheck.assert_playable(out_path)


def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}

    for cid, title, note, variants in CARDS:
        card = {"id": cid, "title": title, "note": note, "variants": []}
        for key, label, text in variants:
            stem = f"r19_{cid}_{key}"
            studio = os.path.join(HERE, f"{stem}.wav")
            synthmod.synth(text, studio)
            wavcheck.assert_playable(studio)
            to_phone(studio, os.path.join(HERE, f"{stem}_phone.wav"))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": f"{stem}.wav", "phone": f"{stem}_phone.wav"})
            print(f"  {stem}  ok  (+phone)")
        manifest["cards"].append(card)

    cid, title, note, variants = COMPOSED
    card = {"id": cid, "title": title, "note": note, "variants": []}
    # The answer is synthesised once and reused by all three, so the ONLY difference a listener
    # hears between them is the opener — which is the comparison the card is for.
    tail = os.path.join(HERE, "r19_f1_tail.wav")
    synthmod.synth(ANSWER_131, tail)
    wavcheck.assert_playable(tail)
    for key, label, opener, gap in variants:
        stem = f"r19_{cid}_{key}"
        studio = os.path.join(HERE, f"{stem}.wav")
        if opener:
            head = os.path.join(HERE, f"{stem}_head.wav")
            synthmod.synth(opener, head)
            wavcheck.assert_playable(head)
            compose([head, gap, tail], studio)
        else:
            # No opener: the caller hears the same gap and then the same answer. The silence goes
            # FIRST, not away — it is what the filler replaces, and a variant that simply started
            # talking sooner would be answering a different question than the one on this card.
            compose([tail, 0.0], studio)          # establishes the rate for the leading silence
            pcm, rate = read_pcm(studio)
            with wave.open(studio, "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
                w.writeframes(struct.pack(f"<{len(pcm) + int(rate * gap)}h",
                                          *([0] * int(rate * gap) + pcm)))
            wavcheck.assert_playable(studio)
        to_phone(studio, os.path.join(HERE, f"{stem}_phone.wav"))
        spoken = f"{opener}  ⟨{gap}s שקט⟩  {ANSWER_131}" if opener else f"⟨{gap}s שקט⟩  {ANSWER_131}"
        card["variants"].append({"key": key, "label": label, "text": spoken,
                                 "file": f"{stem}.wav", "phone": f"{stem}_phone.wav"})
        print(f"  {stem}  ok  (composed +phone)")
    manifest["cards"].append(card)

    json.dump(manifest, open(os.path.join(HERE, "round19.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round19.json")


if __name__ == "__main__":
    main()
