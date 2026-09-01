"""
Round 15 — the two words Koren says she cannot pronounce: נוח and ליד.

Both are CONTENT words, which makes this round different from the filler rounds: when the
round-trip transcriber hears the wrong word it writes different LETTERS (נח for נוח, על יד /
לְיד for ליד), so Soniox is real evidence here and not the weak signal it is for interjections.
His ear still decides.

  נוח  — "no-ach" (comfortable). Cartesia drops the holam and says "nach" (Noah / rested).
         Lives in the booking question: "נוח לךָ מחר בבוקר?"
  ליד  — the loanword "leed". Cartesia reads the Hebrew preposition "le-YAD" (= beside).
         Lives everywhere she talks about enquiries, and Koren stopped a live call twice on it
         (2026-09-01 14:56, [290s]–[310s]: "את לא עושה את ההגייה הנכונה").

Each card offers the three techniques that have ever won in this experiment — minimal niqqud,
phonetic respelling, and leaving the word out — because no technique has ever won twice in a row
here: שלךָ won on a mark, איתכה won on a respelling, and both were per-word decisions by ear.

EVERY VARIANT IS RENDERED TWICE:
  <id>.wav        44.1kHz — what a browser demo sounds like
  <id>_phone.wav  8kHz    — what the caller hears, box-averaged exactly like
                            src/modules/channels/voice-livekit/testing/wav.ts toPhoneRate
The phone clip is the one that decides. נוח collapsing into נח is a phone-band artefact in the
first place; judging it on studio audio is judging a call that never happens.
"""
import json, os, struct, sys, wave
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod
import wavcheck

# Production speaks sonic-3.5 at VOICE_TTS_SPEED / VOICE_TTS_VOLUME. A clip at 1.0/1.0 is not the
# thing the caller hears, and this page exists precisely to hear what he will hear.
synthmod.MODEL = "sonic-3.5"
synthmod.GENERATION_CONFIG = {"speed": 0.9, "volume": 1.4}

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

CARDS = [
    ("n1", "נוח — השאלה שסוגרת פגישה", 'המשפט שבו היא אומרת את זה בפועל, בסוף כל שיחה.', [
        ("A", "היום — כתיב רגיל", "נוח לךָ מחר בבוקר, או שיום אחר עדיף?"),
        ("B", "חולם מלא ופתח", "נוֹחַ לךָ מחר בבוקר, או שיום אחר עדיף?"),
        ("C", "פתח בלבד על החית", "נוחַ לךָ מחר בבוקר, או שיום אחר עדיף?"),
        ("D", "חולם בלבד", "נוֹח לךָ מחר בבוקר, או שיום אחר עדיף?"),
        ("E", "איות פונטי — כמו שנפתר איתכה", "נואח לךָ מחר בבוקר, או שיום אחר עדיף?"),
    ]),
    ("n2", "נוח — בלי המילה בכלל", 'אם אף אחת מהאופציות למעלה לא נשמעת נכון, זו הדרך השנייה: לנסח בלי המילה.', [
        ("A", "מתאים", "מתאים לךָ מחר בבוקר, או שיום אחר עדיף?"),
        ("B", "יוצא", "יוצא לךָ מחר בבוקר, או שיום אחר עדיף?"),
        ("C", "עובד", "מחר בבוקר עובד לךָ, או שיום אחר עדיף?"),
    ]),
    ("l1", "ליד — יחיד", 'המשפט שבו היא מסבירה מה המוצר עושה. זה המשפט שעצרת עליו בשיחה של 14:56.', [
        ("A", "היום — כתיב רגיל", "ככה כל ליד מקבל מענה מהר."),
        ("B", "חיריק על הלמד", "ככה כל לִיד מקבל מענה מהר."),
        ("C", "שתי יודים", "ככה כל לייד מקבל מענה מהר."),
        ("D", "באנגלית בתוך המשפט", "ככה כל lead מקבל מענה מהר."),
    ]),
    ("l2", "לידים — רבים", 'הצורה ברבים נשמעת אחרת, ולכן היא נבחרת בנפרד.', [
        ("A", "היום — כתיב רגיל", "הלידים שנכנסים אליךָ ביום לא מחכים הרבה."),
        ("B", "חיריקים", "הלִידִים שנכנסים אליךָ ביום לא מחכים הרבה."),
        ("C", "שתי יודים", "הליידים שנכנסים אליךָ ביום לא מחכים הרבה."),
        ("D", "באנגלית בתוך המשפט", "ה-leads שנכנסים אליךָ ביום לא מחכים הרבה."),
    ]),
    ("l3", "ליד — בלי המילה בכלל", 'בשיחה עצמה היא כבר ברחה לזה לבד ("אני מתכוונת לפנייה מלקוח"). השאלה אם זו ברירת המחדל.', [
        ("A", "פנייה", "ככה כל פנייה מקבלת מענה מהר."),
        ("B", "פנייה חדשה", "ככה כל פנייה חדשה מקבלת מענה מהר."),
        ("C", "לקוח פוטנציאלי", "ככה כל לקוח פוטנציאלי מקבל מענה מהר."),
    ]),
]


def to_phone(src_path, out_path):
    """8kHz box-average downsample — the same crude low-pass the repo's own toPhoneRate uses.

    Plain decimation would alias and make every candidate sound equally bad, which would quietly
    invalidate the comparison this page exists for.
    """
    with wave.open(src_path, "rb") as w:
        channels, width, rate, frames = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(frames)
    if width != 2:
        raise SystemExit(f"{src_path}: expected 16-bit PCM, got {width * 8}-bit")
    pcm = struct.unpack(f"<{len(raw) // 2}h", raw)
    if channels == 2:                      # mono-ise before resampling, never after
        pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
    ratio = rate / PHONE_RATE
    out_len = int(len(pcm) / ratio)
    out = []
    for i in range(out_len):
        start, end = int(i * ratio), min(int((i + 1) * ratio), len(pcm))
        window = pcm[start:end] or [0]
        out.append(int(round(sum(window) / len(window))))
    with wave.open(out_path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(PHONE_RATE)
        w.writeframes(struct.pack(f"<{len(out)}h", *out))
    wavcheck.assert_playable(out_path)     # never hand over a clip that will not play
    return out_path


def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}
    for cid, title, note, variants in CARDS:
        card = {"id": cid, "title": title, "note": note, "variants": []}
        for key, label, text in variants:
            stem = f"r15_{cid}_{key}"
            studio = os.path.join(HERE, f"{stem}.wav")
            synthmod.synth(text, studio)
            wavcheck.assert_playable(studio)
            to_phone(studio, os.path.join(HERE, f"{stem}_phone.wav"))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": f"{stem}.wav", "phone": f"{stem}_phone.wav"})
            print(f"  {stem}  ok  (+phone)")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round15.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round15.json")


if __name__ == "__main__":
    main()
