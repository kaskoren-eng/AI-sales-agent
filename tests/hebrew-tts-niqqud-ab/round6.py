"""
Round 6 — the six things Koren heard on the 2026-08-30 production calls (2026-08-30).

He listened to two real PSTN calls and gave six notes on how she SOUNDS. Four of them are
pronunciation or prosody, which means none of them can be settled by reading text — they are
settled by synthesizing the candidates and listening, exactly as rounds 3–5 were.

  fl  item 3 — the FILLER WORDS are mispronounced. "במקום להגיד אהה הסוכן אומר אוהה או אההא".
              Every candidate spelling of the receipt/hesitation sound, in the carrier sentence
              production actually speaks them in (they are glued to the front of a reply, never
              said in isolation — so a bare clip would not be the thing he heard).
  nd  item 2 — the VOCAL NOD for mid-dictation. While the caller is reading out a phone number
              she must not say a full receipt ("טוב, הבנתי.") — she must give the short nod that
              means *got it, keep going*. Koren's spelling was "אה אה"; this section is which
              spelling of that actually comes out as a nod. Spoken ALONE, because that is how the
              nod is spoken.
  g   item 1 — רוצה: rotsE (m) / rotsA (f), identical consonants. The masculine mark shipped on
              2026-08-26 BY ANALOGY with שלךָ and was never screened by ear. This section is its
              first listening test. FORCED CHOICE, not ok/bad: the only question is which gender
              you hear, and "sounds fine" is not an answer to it.
  sw  item 1, the sweep — every OTHER ל"ה present-tense verb has the same defect (identical
              spelling, vowel-only gender difference): מחכה, רואה, עושה, עונה, מנסה, מקווה, נראה.
              Plain text only, forced choice, to find which ones actually misread before anything
              is added to speech-guard.ts. Same method as round 3's `ps` sweep.
  nx  item 4 — נוח. "לרוב היא מאוייתת בעברית כ'נח' והסוכן לא מבטא אותה נכון". The suspect is the
              furtive patach: נוֹחַ is NO-ach, two syllables, and unpointed it can come out as one.
  vd  item 5 — לוודא, currently shipped as לוודֵא (round-3 winner) and "not always right".
              Re-tested in the two carriers the real call used, plus a fuller pointing.
  ps  item 6 — flow and pausing: "השימוש בפסיקים ונקודות כדי לעצור באמצע משפט לא עובד כמו שצריך".
              Punctuation variants of the greeting and of the long value-proposition line. Judge
              by ear on the page; the OBJECTIVE half is pause_probe.py, which measures the actual
              silences inside each clip so "the comma did nothing" is a number and not an opinion.

PRODUCTION PARITY — this round differs from rounds 3–5 on purpose. Those synthesized without
`generation_config`, i.e. at speed 1.0 / volume 1.0, while production speaks at
VOICE_TTS_SPEED=0.9 / VOICE_TTS_VOLUME=1.4. For a round about PACING that difference is the whole
subject, so round 6 sends the production values (the same shape the LiveKit plugin sends: a
top-level `generation_config` for sonic-3 models on API version 2025-04-16 —
node_modules/@livekit/agents-plugin-cartesia/dist/tts.js:572).

  python tests/hebrew-tts-niqqud-ab/round6.py           # synth all clips + round6.json
  python tests/hebrew-tts-niqqud-ab/pause_probe.py      # measure silences, back into round6.json
  npx tsx tests/hebrew-tts-niqqud-ab/roundtrip6.ts      # phone-band Soniox round-trip
  python tests/hebrew-tts-niqqud-ab/build_round6_page.py  # -> index-round6.html
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env
from round3 import dur

# PINNED to what production speaks, like round 5 — a verdict table on the wrong model is worse
# than none.
synthmod.MODEL = os.environ.get("ROUND6_MODEL", "sonic-3.5")
# ...and, unlike every earlier round, at the production speed/volume. See the header.
synthmod.GENERATION_CONFIG = {
    "speed": float(os.environ.get("ROUND6_SPEED", "0.9")),
    "volume": float(os.environ.get("ROUND6_VOLUME", "1.4")),
}

SHEVA, TSERE, SEGOL, PATACH, KAMATZ, HOLAM = "ְ", "ֵ", "ֶ", "ַ", "ָ", "ֹ"

# The two carriers taken verbatim from the 2026-08-30 calls, so the clip is the sentence he heard.
GREETING = "שלום, מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"
VALUE = "אנחנו בונים סוכני AI לקול ולוואטסאפ שעונים לפניות, תופסים לידים מהר, ועוזרים לעסקים לסגור יותר בלי לרדוף אחרי כל הודעה בעצמם."

# (card_id, section, what it screens, [(variant_key, variant_label, sentence)], [accepted round-trip
#  fragments — ANY match passes; an empty list means the round-trip cannot judge this card and it
#  is skipped rather than scored)
CARDS = [
    # ── item 3 · filler words ────────────────────────────────────────────────────────────────
    # In the carrier production speaks them in: llmNode injects the word at the head of the reply
    # stream, so Cartesia sees "<word> <first sentence>" as one transcript, never the word alone.
    ("fl1", "fl", "אהה — הקבלה שנשמעת כ'אוהה'", [
        ("A", "היום (אהה.)",            "אהה. כמה פניות נכנסות אליךָ ביום?"),
        ("B", "אה. — בית אחד",           "אה. כמה פניות נכנסות אליךָ ביום?"),
        ("C", f"אֶהֶה — סגול כפול",       f"א{SEGOL}ה{SEGOL}ה. כמה פניות נכנסות אליךָ ביום?"),
        ("D", "אה-הא — מקף",            "אה-הא. כמה פניות נכנסות אליךָ ביום?"),
        ("E", f"אָהָה — קמץ כפול",        f"א{KAMATZ}ה{KAMATZ}ה. כמה פניות נכנסות אליךָ ביום?"),
    ], []),
    ("fl2", "fl", "אה... — ההיסוס", [
        ("A", "היום (אה...)",            "אה... בוא נבדוק מה הכי מתאים לעסק שלךָ."),
        ("B", f"אֶה... — סגול",           f"א{SEGOL}ה... בוא נבדוק מה הכי מתאים לעסק שלךָ."),
        ("C", "אההה... — מוארך",         "אההה... בוא נבדוק מה הכי מתאים לעסק שלךָ."),
    ], []),
    ("fl3", "fl", "אממ... — סינון", [("A", "היום", "אממ... בוא נבדוק מה הכי מתאים לעסק שלךָ.")], []),
    ("fl4", "fl", "רגע... — סינון", [("A", "היום", "רגע... בוא נבדוק מה הכי מתאים לעסק שלךָ.")], []),
    ("fl5", "fl", "שנייה... — סינון", [("A", "היום", "שנייה... בוא נבדוק מה הכי מתאים לעסק שלךָ.")], []),

    # ── item 2 · the mid-dictation nod ───────────────────────────────────────────────────────
    # Spoken ALONE while he is still reading out the number — the whole point is that it is not a
    # sentence. If a candidate sounds like a word rather than a nod, it fails.
    ("nd1", "nd", "אה אה — הנהון קולי", [
        ("A", "אה אה.",                  "אה אה."),
        ("B", "אה-אה.",                  "אה-אה."),
        ("C", "אה, אה.",                 "אה, אה."),
        ("D", "אהה.",                    "אהה."),
        ("E", f"א{PATACH}ה א{PATACH}ה.", f"א{PATACH}ה א{PATACH}ה."),
    ], []),

    # ── item 1 · רוצה, the gender that was never screened ────────────────────────────────────
    # FORCED CHOICE. The round-trip cannot judge these: Soniox writes back the plain word רוצה
    # for both genders, so a PASS here proves only that the mark did not corrupt the word.
    ("g1", "g", "רוצה — פנייה לגבר", [
        ("A", "רגיל, בלי סימן",          "יש משהו שהיית רוצה לשפר בדרך שזה עובד היום?"),
        ("B", f"היום — סגול (רוצ{SEGOL}ה)", f"יש משהו שהיית רוצ{SEGOL}ה לשפר בדרך שזה עובד היום?"),
        ("C", f"חולם + סגול",             f"יש משהו שהיית רו{HOLAM}צ{SEGOL}ה לשפר בדרך שזה עובד היום?"),
        ("D", f"צירה (רוצ{TSERE}ה)",      f"יש משהו שהיית רוצ{TSERE}ה לשפר בדרך שזה עובד היום?"),
    ], ["רוצה"]),
    ("g2", "g", "רוצה — פנייה ישירה לגבר", [
        ("A", "רגיל, בלי סימן",          "אתה רוצה שנקבע דמו קצר עם קורן?"),
        ("B", f"היום — סגול",             f"אתה רוצ{SEGOL}ה שנקבע דמו קצר עם קורן?"),
    ], ["רוצה"]),
    ("g3", "g", "רוצה — קרן על עצמה (נקבה)", [
        ("A", "רגיל, בלי סימן",          "אני רוצה לוודא שהפרטים נכונים."),
        ("B", f"היום — קמץ (רוצ{KAMATZ}ה)", f"אני רוצ{KAMATZ}ה לוודא שהפרטים נכונים."),
    ], ["רוצה"]),

    # ── item 1, the sweep · other ל"ה present-tense verbs ────────────────────────────────────
    # Same defect by construction: masculine ־ֶה / feminine ־ָה on identical consonants. Plain
    # text, exactly what she sends today, so this says which ones are ALREADY wrong. Only the
    # ones that fail get a speech-guard entry — nothing is marked on theory.
    ("sw1", "sw", "מחכה — קרן על עצמה (נקבה)", [("A", "רגיל", "אני כאן, אין לחץ — קח את הזמן שאתה צריך ואני מחכה.")], ["מחכה"]),
    ("sw2", "sw", "רואה — קרן על עצמה (נקבה)", [("A", "רגיל", "אני רואה שיש פה כמה אפשרויות טובות.")], ["רואה"]),
    ("sw3", "sw", "עושה — הלקוח (זכר)",        [("A", "רגיל", "ספר לי בשתי מילים מה אתה עושה בעסק.")], ["עושה"]),
    ("sw4", "sw", "עונה — הסוכן (זכר)",        [("A", "רגיל", "הסוכן עונה לכל פנייה תוך שניות.")], ["עונה"]),
    ("sw5", "sw", "מנסה — הלקוח (זכר)",        [("A", "רגיל", "אם אתה מנסה לתפוס כל פנייה לבד, זה שוחק.")], ["מנסה"]),
    ("sw6", "sw", "מקווה — קרן על עצמה (נקבה)", [("A", "רגיל", "אני מקווה שזה עוזר לךָ להבין את זה.")], ["מקווה"]),
    ("sw7", "sw", "נראה — על העסק (זכר)",      [("A", "רגיל", "זה נראה מתאים בול לעסק שלךָ.")], ["נראה"]),

    # ── item 4 · נוח ─────────────────────────────────────────────────────────────────────────
    # The suspect is the furtive patach — נוֹחַ is NO-ach, and unpointed sonic-3.5 can flatten it
    # to one syllable. D tests his own observation that the word is often written נח.
    ("nx1", "nx", "נוח — 'מתי נוח לך'", [
        ("A", "רגיל (נוח)",              "מתי נוח לךָ — מחר בבוקר או אחר הצהריים?"),
        ("B", f"פתח בח׳ (נוח{PATACH})",   f"מתי נוח{PATACH} לךָ — מחר בבוקר או אחר הצהריים?"),
        ("C", f"חולם + פתח",              f"מתי נו{HOLAM}ח{PATACH} לךָ — מחר בבוקר או אחר הצהריים?"),
        ("D", "כתיב חסר (נח)",           "מתי נח לךָ — מחר בבוקר או אחר הצהריים?"),
        ("E", "איות פונטי (נואח)",        "מתי נואח לךָ — מחר בבוקר או אחר הצהריים?"),
    ], ["נוח", "נח"]),
    ("nx2", "nx", "נוח — 'נוח לך מחר?'", [
        ("A", "רגיל (נוח)",              "בוא נקבע — נוח לךָ מחר?"),
        ("C", f"חולם + פתח",              f"בוא נקבע — נו{HOLAM}ח{PATACH} לךָ מחר?"),
    ], ["נוח", "נח"]),

    # ── item 5 · לוודא ───────────────────────────────────────────────────────────────────────
    ("vd1", "vd", "לוודא — 'רק לוודא, נכון?'", [
        ("A", "רגיל (לוודא)",            "רק לוודא — קורן שטרית, נכון?"),
        ("B", f"היום — צירה (לווד{TSERE}א)", f"רק לווד{TSERE}א — קורן שטרית, נכון?"),
        ("C", f"ניקוד מלא",               f"רק ל{SHEVA}ו{PATACH}וד{TSERE}א — קורן שטרית, נכון?"),
        ("D", "איות עם ה׳ (לוודה)",       "רק לוודה — קורן שטרית, נכון?"),
    ], ["לוודא", "לוודה"]),
    ("vd2", "vd", "לוודא — 'רוצה לוודא ש...'", [
        ("A", "רגיל (לוודא)",            "אני רוצה לוודא שהפרטים נכונים."),
        ("B", f"היום — צירה",             f"אני רוצה לווד{TSERE}א שהפרטים נכונים."),
        ("C", f"ניקוד מלא",               f"אני רוצה ל{SHEVA}ו{PATACH}וד{TSERE}א שהפרטים נכונים."),
    ], ["לוודא", "לוודה"]),

    # ── item 6 · pausing and flow ────────────────────────────────────────────────────────────
    # E is a PROBE, not a candidate: sonic-3.5 publishes no pause markup, so this asks whether the
    # tag is honoured, ignored, or read out loud. If you hear the letters, that answers it.
    ("ps1", "ps", "פתיחת השיחה — הפסקות", [
        ("A", "היום — פסיקים",            GREETING),
        ("B", "מקפים ארוכים",             "שלום — מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"),
        ("C", "פיצול למשפטים",            "שלום. מדברת קרן. העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"),
        ("D", "שלוש נקודות",              "שלום... מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?"),
        ("E", "בדיקה: תגית break",        'שלום <break time="0.35s"/> מדברת קרן, העוזרת הדיגיטלית של ClickScales. איך אני יכולה לעזור?'),
    ], ["מדברת קרן"]),
    ("ps2", "ps", "משפט הערך הארוך — הפסקות", [
        ("A", "היום — שרשרת פסיקים",      VALUE),
        ("B", "פיצול למשפטים",            "אנחנו בונים סוכני AI לקול ולוואטסאפ. הם עונים לפניות. תופסים לידים מהר. ועוזרים לעסקים לסגור יותר בלי לרדוף אחרי כל הודעה בעצמם."),
    ], ["סוכני"]),
]


def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}
    for cid, section, word, variants, hear in CARDS:
        card = {"id": cid, "section": section, "word": word, "hear": hear, "variants": []}
        for key, label, text in variants:
            fname = f"r6_{cid}_{key}.wav"
            path = os.path.join(HERE, fname)
            # Existing clips are kept: the round-trip verdicts and Koren's ear must judge the SAME
            # audio. Delete a wav (or pass --resynth) to regenerate it.
            if "--resynth" in sys.argv or not os.path.exists(path):
                synth(text, path)
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": fname, "dur": round(dur(path), 2)})
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round6.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round6.json")


if __name__ == "__main__":
    main()
