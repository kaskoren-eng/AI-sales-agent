"""
Round 3 — pronunciation polish for specific problem words, on the CURRENT production model
(reads CARTESIA_MODEL from .env — sonic-3.5 as of 2026-08-26; rounds 1-2 ran on sonic-3).

Four sections:
  vd  — לוודא: the final-aleph vowel gets dropped ("levad"). Candidates: ה-respelling / minimal tsere.
  m   — לך/שלך masculine: production already respells to לכה/שלכה, but "sometimes a wrong
        pronounce" — A/B the current respelling against plain and against the minimal-kamatz
        variant Koren picked in the (uncommitted) Jul-17 round, now on sonic-3.5.
  f   — לך/שלך feminine: candidates for the planned SECOND_PERSON_FEMININE table —
        the respelling from the speech-guard.ts TODO (לאך/שלאך) vs minimal niqqud (לָךְ/שלָךְ).
  ps  — פ/ש screening: frequent agent words containing פ/ש, plain text only. Not an A/B —
        a listening sweep to identify which words actually misread on sonic-3.5 before fixing.

Variants are per-card, labeled with WHAT the trick is, so the verdict maps 1:1 to a
speech-guard table entry. Output: r3_<id>_<V>.wav + round3.json; page via build_round3_page.py.
"""
import json, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import synth as synthmod
from synth import synth, load_env

# Rounds 1-2 hardcoded sonic-3; round 3 must run on what production runs today.
synthmod.MODEL = load_env("CARTESIA_MODEL")

TSERE, KAMATZ, SHEVA = "ֵ", "ָ", "ְ"

# (card_id, section, target_word_display, [ (variant_key, variant_label, sentence) ])
CARDS = [
    # -- לוודא ------------------------------------------------------------------
    ("vd1", "vd", "לוודא", [
        ("A", "רגיל — מה שנשלח היום",        "אני רוצה לוודא שהפרטים נכונים."),
        ("B", "איות עם ה׳ (לוודה)",           "אני רוצה לוודה שהפרטים נכונים."),
        ("C", "ניקוד מינימלי (לוודֵא)",        f"אני רוצה לווד{TSERE}א שהפרטים נכונים."),
    ]),
    ("vd2", "vd", "לוודא", [
        ("A", "רגיל — מה שנשלח היום",        "רק לוודא, הפגישה מחר בעשר?"),
        ("B", "איות עם ה׳ (לוודה)",           "רק לוודה, הפגישה מחר בעשר?"),
        ("C", "ניקוד מינימלי (לוודֵא)",        f"רק לווד{TSERE}א, הפגישה מחר בעשר?"),
    ]),
    # -- masculine ---------------------------------------------------------------
    ("m1", "m", "לך (זכר)", [
        ("A", "הפקה היום (לכה)",              "יש לכה כמה דקות לדבר?"),
        ("B", "רגיל, בלי תיקון (לך)",          "יש לך כמה דקות לדבר?"),
        ("C", "ניקוד מינימלי (לךָ)",           f"יש לך{KAMATZ} כמה דקות לדבר?"),
    ]),
    ("m2", "m", "שלך (זכר)", [
        ("A", "הפקה היום (שלכה)",             "מה כתובת המייל שלכה?"),
        ("B", "רגיל, בלי תיקון (שלך)",         "מה כתובת המייל שלך?"),
        ("C", "ניקוד מינימלי (שלךָ)",          f"מה כתובת המייל שלך{KAMATZ}?"),
    ]),
    # -- feminine ----------------------------------------------------------------
    ("f1", "f", "לך (נקבה)", [
        ("A", "רגיל, בלי תיקון (לך)",          "יש לך כמה דקות לדבר?"),
        ("B", "איות פונטי (לאך)",              "יש לאך כמה דקות לדבר?"),
        ("C", "ניקוד מינימלי (לָךְ)",           f"יש ל{KAMATZ}ך{SHEVA} כמה דקות לדבר?"),
    ]),
    ("f2", "f", "שלך (נקבה)", [
        ("A", "רגיל, בלי תיקון (שלך)",         "מה כתובת המייל שלך?"),
        ("B", "איות פונטי (שלאך)",             "מה כתובת המייל שלאך?"),
        ("C", "ניקוד מינימלי (שלָךְ)",          f"מה כתובת המייל של{KAMATZ}ך{SHEVA}?"),
    ]),
    # -- פ/ש screening (plain only — find the offenders before fixing) ------------
    ("ps1", "ps", "פגישה · אפשר",  [("A", "רגיל", "אפשר לקבוע פגישה לשבוע הבא?")]),
    ("ps2", "ps", "פרטים · טלפון", [("A", "רגיל", "אשלח את הפרטים למספר הטלפון הזה.")]),
    ("ps3", "ps", "פתרון · פשוט · לשפר · שירות",
                                   [("A", "רגיל", "יש לנו פתרון פשוט שיכול לשפר את השירות.")]),
    ("ps4", "ps", "שעה · שאלות",   [("A", "רגיל", "באיזו שעה נוח, ויש שאלות שכדאי להכין?")]),
    ("ps5", "ps", "נשמע · שמח",    [("A", "רגיל", "נשמע מצוין, אני שמח לשמוע.")]),
]

def dur(path):
    b = open(path, "rb").read(); i = 12
    while i + 8 <= len(b):
        if b[i:i+4] == b"data": return (len(b) - (i + 8)) / 88200
        sz = struct.unpack("<I", b[i+4:i+8])[0]
        if sz == 0xFFFFFFFF or i + 8 + sz > len(b): break
        i += 8 + sz + (sz & 1)
    return (len(b) - 78) / 88200

def main():
    print(f"model: {synthmod.MODEL}")
    manifest = {"model": synthmod.MODEL, "cards": []}
    for cid, section, word, variants in CARDS:
        card = {"id": cid, "section": section, "word": word, "variants": []}
        for key, label, text in variants:
            fname = f"r3_{cid}_{key}.wav"
            synth(text, os.path.join(HERE, fname))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": fname, "dur": round(dur(os.path.join(HERE, fname)), 2)})
            print(f"  {cid}_{key}  {text}")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round3.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote round3.json")

if __name__ == "__main__":
    main()
