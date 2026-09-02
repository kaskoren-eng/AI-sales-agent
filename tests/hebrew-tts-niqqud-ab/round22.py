"""
Round 22 — the engine question, given ears: Cartesia sonic-3.5 vs DeepDub dd-etts-3.2.

Round 21's verdicts ended somewhere nobody planned: the only breath that survived was DeepDub's
own (b0: source A only; b1: C, the -24dB dd inhale; everything else "פשוט לא טובים"), and Koren's
conclusion was *"צריך לעבור כנראה לדיפדאב אני בוחן את זה כרגע"*. This page is that examination,
run the only way this directory trusts: the SAME sentences, from the live prompt, phone band,
side by side. DeepDub already won a blind A/B 6:1 once (2026-07) and Cartesia was kept anyway —
so this is a re-hearing with today's stakes, not a first hearing.

WHAT EACH VARIANT IS:
  A — Cartesia sonic-3.5 at production knobs (speed 0.9, volume 1.4). What she sounds like today.
  B — DeepDub through OUR OWN adapter (deepdub.tts.ts, the exact production code path behind
      VOICE_TTS_PROVIDER=deepdub), voicePromptId from .env, accentControl 0.75. NOTE: DeepDub's
      adapter has NO speed/volume knobs — what you hear is what production would say.
  C — (pricing card only) round 21's sole survivor: Cartesia + the dd inhale at -24dB. The
      three-way puts "switch engines" against "keep Cartesia and borrow the breath".

THE DECISION THIS FEEDS, and what a B-sweep would re-open (from the handoff):
  no speed knob (prod is 0.9 on Cartesia) · niqqud fixes tuned by ear on Cartesia (שלךָ carries
  through here untouched — listen for it) · the <break> pause whitelist is Cartesia SSML ·
  cost/min unknown · warm TTFB measured today 336-502ms vs Cartesia's ~217ms bench.

  python tests/hebrew-tts-niqqud-ab/round22.py
"""
import json, os, struct, sys, wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wavcheck

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

# (id, title, note, [(key, label, source-file)])
CARDS = [
    ("pr", "1 · שאלת המחיר — התלת-כיווני",
     "התשובה הארוכה. כאן גם C — המנצח היחיד של סבב 21: קרטסיה עם הנשימה השאולה ב-‎-24dB. "
     "שלוש דרכים לאותו משפט: הקול של היום, המנוע שנושם לבד, והפשרה.",
     [("A", "קרטסיה — מה שהיא היום", "r21_m5_A.wav"),
      ("B", "DeepDub נטיבי", "r22_pr_dd.wav"),
      ("C", "קרטסיה + נשימת DeepDub ‎-24dB (הזוכה של סבב 21)", "r21_b1_C.wav")]),
    ("em", "2 · הרגע האמפתי",
     "המשפט שנבחר בסבב 16. רגש הוא בדיוק המגרש שבו DeepDub אמור להצטיין — וגם המקום שבו "
     "זיוף נשמע הכי מהר.",
     [("A", "קרטסיה", "r21_em_plain.wav"),
      ("B", "DeepDub", "r22_em_dd.wav")]),
    ("ca", "3 · בדיקת היומן — שורת הכלי",
     "הטקסט שהיא אומרת בכל בדיקת יומן איטית. משפט תפעולי קצר — כאן ההבדל הוא בקצב, לא ברגש.",
     [("A", "קרטסיה", "r22_ca_ct.wav"),
      ("B", "DeepDub", "r22_ca_dd.wav")]),
    ("bk", "4 · הקראת הפגישה",
     "עובדה שהיא בטוחה בה: יום ושעה. מבחן הבהירות — האם השעה נקלטת — לפני מבחן האנושיות.",
     [("A", "קרטסיה", "r22_bk_ct.wav"),
      ("B", "DeepDub", "r22_bk_dd.wav")]),
    ("ng", "5 · משפט הפתיחה",
     "המשפט הראשון שכל ליד שומע, כולל השם ClickScales באנגלית בתוך עברית — מבחן ה-code-switch.",
     [("A", "קרטסיה", "r22_ng_ct.wav"),
      ("B", "DeepDub", "r22_ng_dd.wav")]),
]

# Warm TTFB per DeepDub sentence, measured 2026-09-02 through dd_synth22.ts. Cartesia's bench
# figure for the same class of sentence is ~217ms (phase-4-known-issues latency table).
DD_TTFB = {"pr": 502, "em": 370, "ca": 366, "bk": 336, "ng": 409}


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
    for cid, title, note, variants in CARDS:
        entry = {"id": cid, "title": title, "note": note, "ttfb_dd": DD_TTFB.get(cid),
                 "variants": []}
        for key, label, src in variants:
            phone = f"r22_{cid}_{key}_phone.wav"
            to_phone(src, phone)
            with wave.open(os.path.join(HERE, phone), "rb") as w:
                ms = round(w.getnframes() / w.getframerate() * 1000)
            entry["variants"].append({"key": key, "label": label, "file": phone, "ms": ms})
            print(f"{cid}_{key}: -> {phone} ({ms}ms)")
        manifest["cards"].append(entry)
    json.dump(manifest, open(os.path.join(HERE, "round22.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round22.json")


if __name__ == "__main__":
    main()
