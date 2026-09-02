"""
Round 21 — does she breathe, and does it help? The first breath audio ever put in front of an ear.

(This round was born as round 20 and renumbered the same afternoon: the other voice session took
the number for the מספר/דמו pronunciation round while this one was being built — two sessions,
one untracked directory, no claims table for round numbers. Every artifact here is r21_*; the
probe files are probe21_*/roundtrip21.ts for the same reason. The r21_m5_*/r21_m6_* clips are the
tag PROBE's output — m5/m6 = sonic-3.5/3.6, unrelated to round 20's m1-m3 cards.)

THE TAG ROUTE DIED FIRST, and this round exists because of how it died. probe21_tags.py +
roundtrip21.ts (2026-09-02) re-dated round 4's verdict on both current snapshots: every
breath-shaped English tag ([breath], [inhales], [breathing], [sigh]/[sighs], [breathes],
[exhales], [laughs], [coughs], [clears throat]) is INERT on Hebrew sonic-3.5 AND sonic-3.6 —
duration deltas inside the 320-480ms generation-noise floor, onset anatomy clean, Soniox
transcripts identical to baseline. The parenthesized form `(breathes)` is READ ALOUD ("ברידס").
The one exception is `[laughter]`: it renders a real "חח" on BOTH models — the tag machinery
works on Hebrew; Cartesia simply trained exactly one non-verbal, and it is the one Koren banned
in round 4b. So a breath is audio WE SUPPLY, spliced into her stream — which is what production
would do (frames enqueued into the TTS output), and what every card here auditions.

TWO BREATH SOURCES PER QUESTION, because neither can be trusted alone yet:
  dd     — harvested from a DeepDub dd-etts-3.2 Hebrew generation (breath_mix.py harvest), the
           inhale-shaped candidate at 19030ms: sound after 440ms of silence, before speech. A
           female TTS voice breathing for real — but possibly a fricative wearing a breath's
           statistics, which is exactly what card b0 lets Koren veto.
  synth  — a 320ms shaped-noise inhale built from numbers alone (band-limited noise, rising
           envelope). Fully controlled, timbre-neutral; if THIS passes at phone band, the asset
           question becomes easy forever.

THE GAIN IS THE CARD VARIABLE. A phone breath lives just above the noise floor; -18dB vs -24dB
relative to her speech RMS is the difference between "she breathed" and nothing at all — nobody
knows which side of the line the 8kHz band puts them on, so b1 carries the ladder. Measured after
the fact: at phone band the -24dB breath peaks at 4.8% of clip peak, -18dB at 9.6%, -12dB at
19.1%, against a 2.0% silent-head floor — audible, quiet, and graded as intended.

  b0  the breaths solo — an instrument card: veto a source before judging its placements.
  b1  inhale BEFORE the long pricing reply (the round-18 `pr` sentence) — dd/-18, dd/-24, synth/-18.
  b2  breath at the seam of the round-16 empathy pair ("אני מבינה. | זה באמת מתסכל.").
  b3  breath inside a THINKING GAP: filler, gap, answer — as the agent actually stalls.
  b4  ⚠️ NEGATIVE: inhale before a two-word confirmation. The prompt-forbidden spot. B should
      sound fake; if it doesn't, the placement rule is too strict.
  b5  ⚠️ NEGATIVE: the same inhale at -12dB — the panting ceiling. Expected wrong.

PHONE BAND ONLY, like round 18: the 8kHz clip decides, and the page goes on his phone.

Roundtrip evidence (probe21-heard.json): the mixed breaths are NOT transcribed as words — b1/b4
come back word-identical to baseline, b3's filler reads as "אממ." either way.

  python tests/hebrew-tts-niqqud-ab/round21.py
"""
import json, os, struct, sys, wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wavcheck
from breath_mix import read_wav, write_wav, splice

HERE = os.path.dirname(os.path.abspath(__file__))
PHONE_RATE = 8000

DD = "breaths/dd_19030ms_140ms.wav"
SYNTH = "breaths/synth_inhale_320ms.wav"

# Base clips, all sonic-3.5 at production speed/volume (0.9/1.4), synthesized 2026-09-02:
LONG = "r21_m5_A.wav"        # המחיר נקבע לפי כמה שיחות... כמה פניות נכנסות אליךָ בחודש?
EM = "r21_em_plain.wav"      # אני מבינה. זה באמת מתסכל.   (seam: gap 820-1240ms)
CF = "r21_cf_plain.wav"      # בטח, אני רושמת את זה.
FILLER = "r21_filler.wav"    # אֶממ...


def compose(paths_and_silences, out_path):
    """Concatenate clips and silences: [(path|None, ms), ...] — None = silence of that length."""
    out, rate = [], None
    for path, ms in paths_and_silences:
        if path is None:
            out += [0] * int((rate or 44100) * ms / 1000)
        else:
            pcm, r = read_wav(os.path.join(HERE, path))
            if rate is None:
                rate = r
            elif r != rate:
                raise SystemExit(f"{path}: rate {r} != {rate}")
            out += pcm
    write_wav(os.path.join(HERE, out_path), out, rate)


def to_phone(src, dst):
    """8kHz box-average — same crude low-pass as rounds 16-20 and the repo's toPhoneRate."""
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
    os.chdir(HERE)

    # b1 — inhale before the long reply.
    splice(LONG, DD, 0, -18, "r21_b1_B.wav")
    splice(LONG, DD, 0, -24, "r21_b1_C.wav")
    splice(LONG, SYNTH, 0, -18, "r21_b1_D.wav")
    # b2 — breath at the empathy seam (gap 820-1240ms; mid-gap = 1030ms).
    splice(EM, DD, 1030, -20, "r21_b2_B.wav")
    splice(EM, SYNTH, 1030, -20, "r21_b2_C.wav")
    # b3 — the thinking gap, composed like round-19's f1: filler, real silence, answer. The breath
    # belongs INSIDE the gap: B appends it to the filler (splice at an offset past the clip's end
    # = append) and shortens the remaining silence, so the gap grows only slightly — exactly what
    # production frame-insertion into dead air would do.
    compose([(FILLER, 0), (None, 400), (LONG, 0)], "r21_b3_A.wav")
    splice(FILLER, DD, 10 ** 9, -18, "r21_tmp_filler_breath.wav")
    compose([("r21_tmp_filler_breath.wav", 0), (None, 250), (LONG, 0)], "r21_b3_B.wav")
    # b4 — NEGATIVE: inhale before the short confirmation.
    splice(CF, DD, 0, -18, "r21_b4_B.wav")
    # b5 — NEGATIVE: the panting ceiling.
    splice(LONG, DD, 0, -12, "r21_b5_B.wav")

    # b0 solo clips — boosted to audition level. The raw candidates sit 18-24dB under speech by
    # nature; unboosted they are nearly inaudible at phone band and the card would judge silence.
    for src, dst in ((DD, "r21_b0_A_src.wav"), (SYNTH, "r21_b0_B_src.wav")):
        pcm, rate = read_wav(os.path.join(HERE, src))
        peak = max(abs(s) for s in pcm) or 1
        write_wav(os.path.join(HERE, dst), [s * (16000 / peak) for s in pcm], rate)

    cards = [
        ("b0", "0 · הנשימות עצמן — כרטיס מכשיר", None,
         "לפני שאתה שופט איפה נשימה יושבת — האם אלה בכלל נשימות? A נקצרה מדיבור אמיתי של DeepDub "
         "(קול נשי, נמצאה אחרי 440ms שקט לפני משפט). B נבנתה מרעש מעוצב בלבד. אם אחת נשמעת "
         "כמו עיצור או רעש קו — פסול אותה, וכל הכרטיסים שמשתמשים בה נופלים איתה.",
         [("A", "נשימת DeepDub (נקצרה)", "r21_b0_A_src.wav"),
          ("B", "שאיפה סינתטית (רעש מעוצב)", "r21_b0_B_src.wav")]),
        ("b1", "1 · שאיפה לפני תשובה ארוכה", None,
         "משפט המחיר — התשובה הארוכה שאדם היה נושם לפניה. השאלה הכפולה: איזה מקור, ובאיזו עוצמה. "
         "‎-18dB מתחת לדיבור = נשימה שנוכחת; ‎-24dB = כמעט סף שמיעה בפס טלפון.",
         [("A", "בלי נשימה — מה שהיא עושה היום", LONG),
          ("B", "נשימת DeepDub, ‎-18dB", "r21_b1_B.wav"),
          ("C", "נשימת DeepDub, ‎-24dB", "r21_b1_C.wav"),
          ("D", "שאיפה סינתטית, ‎-18dB", "r21_b1_D.wav")]),
        ("b2", "2 · נשימה בתפר בין משפטים", None,
         "צמד האמפתיה שאישרת בסבב 16. הנשימה יושבת בתוך הפער הקיים בין ״אני מבינה.״ ל״זה באמת "
         "מתסכל.״ — לא מוסיפה זמן מת, מחליפה שקט בנוכחות.",
         [("A", "בלי נשימה", EM),
          ("B", "נשימת DeepDub, ‎-20dB", "r21_b2_B.wav"),
          ("C", "שאיפה סינתטית, ‎-20dB", "r21_b2_C.wav")]),
        ("b3", "3 · נשימה בפער חשיבה", None,
         "הרצף האמיתי של תקיעה: פילר, שקט, ואז התשובה. ב-B הנשימה ממלאת חלק מהשקט — בדיוק מה "
         "שהקוד היה עושה (מכניס פריימים לפער, לא מאריך אותו).",
         [("A", "אֶממ... ואז שקט ואז התשובה", "r21_b3_A.wav"),
          ("B", "אֶממ... נשימה בתוך השקט, ואז התשובה", "r21_b3_B.wav")]),
        ("b4", "4 · ⚠️ בקרה שלילית — אישור קצר", "צפוי להישמע מזויף",
         "שאיפה לפני ״בטח, אני רושמת את זה.״ — בדיוק המקום שחוק ההפעלה יאסור (תשובה קצרה ומיידית). "
         "אם B דווקא נשמע טבעי — החוק מחמיר מדי.",
         [("A", "בלי נשימה", CF),
          ("B", "נשימת DeepDub, ‎-18dB", "r21_b4_B.wav")]),
        ("b5", "5 · ⚠️ בקרה שלילית — תקרת ההתנשפות", "צפוי להישמע חזק מדי",
         "אותה שאיפה של כרטיס 1, ב-‎-12dB — קרוב מדי לעוצמת הדיבור. הגבול העליון של הסקאלה, "
         "כדי שנדע איפה ״נושמת״ הופך ל״מתנשפת״.",
         [("A", "בלי נשימה", LONG),
          ("B", "נשימת DeepDub, ‎-12dB — חזק מדי בכוונה", "r21_b5_B.wav")]),
    ]

    manifest = {"cards": []}
    for cid, title, warn, note, variants in cards:
        entry = {"id": cid, "title": title, "warn": warn, "note": note, "variants": []}
        for key, label, src in variants:
            phone = f"r21_{cid}_{key}_phone.wav"
            to_phone(src, phone)
            with wave.open(os.path.join(HERE, phone), "rb") as w:
                ms = round(w.getnframes() / w.getframerate() * 1000)
            entry["variants"].append({"key": key, "label": label, "file": phone, "ms": ms,
                                      "studio": src})
            print(f"{cid}_{key}: -> {phone} ({ms}ms)")
        manifest["cards"].append(entry)

    if os.path.exists(os.path.join(HERE, "r21_tmp_filler_breath.wav")):
        os.remove(os.path.join(HERE, "r21_tmp_filler_breath.wav"))
    json.dump(manifest, open(os.path.join(HERE, "round21.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round21.json")


if __name__ == "__main__":
    main()
