"""
Round 23 — the DeepDub screening: do the Cartesia-tuned fixes survive the engine Koren chose?

Round 22 was a 5/5 sweep for DeepDub. Before any flip, every by-ear verdict that lives in
PRONUNCIATION_FIXES and the gendered pointing has to be re-heard on the new engine — those rows
were decided on Cartesia clips, one word at a time, and this directory's whole history says such
verdicts do not transfer on theory. Each card: A = pointed (what the guard emits today, fixes ON),
B = plain (fixes OFF). Four outcomes per word:

  A right, B wrong  -> the fix transfers; keep it.
  A right, B right  -> DeepDub never needed it; the row is dead weight there (harmless).
  A wrong, B right  -> the fix is HARMFUL on DeepDub; the guard needs a provider condition.
  A wrong, B wrong  -> a new fix must be tuned on DeepDub clips (a future round).

Words under test: שלךָ (gender), מִסְפָּר, נוֹחַ, לִידִים, דֶמוֹ, אֶממ — rounds 3/10/15/20's verdicts.
Clips synthesized by dd_synth23.ts through the production adapter. Phone band decides, as always.

  npx tsx tests/hebrew-tts-niqqud-ab/dd_synth23.ts   (first — makes the clips)
  python tests/hebrew-tts-niqqud-ab/round23.py       (then — phone band + manifest)
"""
import json, os, struct, sys, wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wavcheck

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

CARDS = [
    ("sl", "1 · שלךָ + מִסְפָּר — הפנייה המגדרית",
     "הצירוף שחוזר בכל שיחה. A זה מה שהמנגנון שולח היום (מנוקד); B זה הטקסט הגולמי. השאלה: "
     "האם DeepDub בכלל צריך את הניקוד, והאם הוא סובל אותו.",
     "מה מִסְפָּר הטלפון שלךָ?", "מה מספר הטלפון שלך?"),
    ("nh", "2 · נוֹחַ — המילה שסוגרת כל שיחה",
     "בקרטסיה, בלי ניקוד זה יצא ״נח״ ועצרת שיחה חיה על זה (סבב 15). מה DeepDub עושה איתה — "
     "לבד, ועם התיקון.",
     "נוֹחַ לךָ מחר בבוקר?", "נוח לך מחר בבוקר?"),
    ("ld", "3 · לִידִים — מילת ההלוואה",
     "בקרטסיה ״לידים״ נקרא כמו ״ליד״ (מקום) ושברת על זה שיחה פעמיים. הניקוד תיקן. האם DeepDub "
     "קורא את המילה נכון מעצמו?",
     "כמה לִידִים נכנסים אליךָ בשבוע?", "כמה לידים נכנסים אליך בשבוע?"),
    ("dm", "4 · דֶמוֹ — המילה שכמעט הייתה דם",
     "בלי ניקוד ״דמו״ יכול להיקרא דָּמוֹ. התיקון נכנס היום (סבב 20 של הסשן השני). על DeepDub?",
     "אפשר לקבוע דֶמוֹ קצר עם קורן.", "אפשר לקבוע דמו קצר עם קורן."),
    ("fl", "5 · אֶממ — פילר החשיבה",
     "ההיסוס שהיא משמיעה כשכלי איטי. הכתיב המנוקד הוא פסיקה של סבב 10 — על קרטסיה. איך DeepDub "
     "מבטא את שתי הצורות?",
     "אֶממ... זה תלוי בכמה שיחות.", "אממ... זה תלוי בכמה שיחות."),
]


def to_phone(src, dst):
    """8kHz box-average — same crude low-pass as every round since 16."""
    with wave.open(os.path.join(HERE, src), "rb") as w:
        ch, rate, n = w.getnchannels(), w.getframerate(), w.getnframes()
        pcm = list(struct.unpack(f"<{n * ch}h", w.readframes(n)))
    if ch == 2:
        pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
    ratio = rate / PHONE_RATE
    out = []
    for i in range(int(len(pcm) / ratio)):
        a, b = int(i * ratio), max(int(i * ratio) + 1, int((i + 1) * ratio))
        seg = pcm[a:b]
        out.append(sum(seg) // len(seg))
    dstp = os.path.join(HERE, dst)
    with wave.open(dstp, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(PHONE_RATE)
        w.writeframes(struct.pack(f"<{len(out)}h", *out))
    wavcheck.finalize(dstp)


def main():
    manifest = {"cards": []}
    for cid, title, note, text_a, text_b in CARDS:
        entry = {"id": cid, "title": title, "note": note, "variants": []}
        for key, text in (("A", text_a), ("B", text_b)):
            src = f"r23_{cid}_{key}.wav"
            phone = f"r23_{cid}_{key}_phone.wav"
            to_phone(src, phone)
            with wave.open(os.path.join(HERE, phone), "rb") as w:
                ms = round(w.getnframes() / w.getframerate() * 1000)
            label = "מנוקד — מה שהמנגנון שולח היום" if key == "A" else "חלק — בלי שום תיקון"
            entry["variants"].append({"key": key, "label": label, "text": text,
                                      "file": phone, "ms": ms})
            print(f"{cid}_{key}: -> {phone} ({ms}ms)")
        manifest["cards"].append(entry)
    json.dump(manifest, open(os.path.join(HERE, "round23.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round23.json")


if __name__ == "__main__":
    main()
