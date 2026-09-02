"""
Round 17 — after round 16 killed the rate lever and picked the pause instead.

KOREN'S ROUND-16 VERDICTS, and what each one settles:

  sp: -   "נשמעים אותו דבר למעט אופציה D שאיטית מדי"
          0.90 vs 0.84 vs 0.78 are INDISTINGUISHABLE to him. Only 0.72 was audible, and it was
          wrong. The duration table said 0.78 buys +13.7% — it does, and he cannot hear it.
  tr: A   A is "no transition, both at 0.90". Asked directly whether a rate change between turns
          sounds like a person slowing down, he chose the clip with no rate change at all.

          Those two together END THE RATE LEVER. `speedFor` shipped on 2026-09-02 with a 0.87
          multiplier on the hesitant register; two cards say nobody can hear it. A knob that
          measures and does not sound is not a feature, and the measurement was mine.

  br: D   `<break time="0.35s"/>`. It wins, it is verified not spoken (roundtrip16), and its
          duration scales with the request. THIS is the pause mechanism.
  em: -   No winner among comma / full stop / ellipsis / dash for the empathetic beat. So the
          empathetic register currently has NO audible mechanism at all — which is why `eb` below
          re-asks it with the tag that did win.
  df: D   "אֶה..." mid-sentence. *"העצירה קצת ארוכה מדי אבל הכיוון הזה הוא נכון וטוב, רק צריך
          לשזור את זה נכון כדי שייכנס במשפטים שנכון והגיוני שהיא תחשוב בהם ולא בדברים פשוטים
          או בכל משפט."*

          Three separate instructions in one sentence, and this round takes them one at a time:
          the pause is too long (`ah`), it belongs on sentences worth thinking about (`wh`), and
          it must not be on every sentence (that one is a budget, not a sound — it goes to the
          filler ledger, not to a listening card).

  ah  HOW LONG the mid-sentence hesitation should be. Same sentence, five pause lengths.
  wh  WHERE it belongs. The same hesitation on a sentence that deserves thought and on one that
      does not — so the difference between apt and inapt placement is something he HEARS rather
      than something I assert.
  bk  THE TAG'S LENGTH inside a real hesitant reply, now that the tag has won its card.
  eb  THE EMPATHETIC BEAT, re-asked with `<break>` after punctuation drew a blank.

sonic-3.5, speed 0.9, volume 1.4 — production, and the speed is now FIXED at production for every
clip on this page. Round 16 settled that it is not a variable.

  python tests/hebrew-tts-niqqud-ab/round17.py
  python tests/hebrew-tts-niqqud-ab/build_round17_page.py   # -> index-round17.html
  npx tsx tests/hebrew-tts-niqqud-ab/roundtrip17.ts         # is anything READ ALOUD?
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
    ("ah", "1 · כמה ארוכה ההיסוס באמצע המשפט",
     "בחרת ב-D בכרטיס 5 ואמרת שהעצירה קצת ארוכה מדי. אותו משפט בדיוק, חמישה אורכי עצירה. "
     "A הוא מה שבחרת. שלוש הנקודות הן הארוכות ביותר שיש בפיסוק — התגית מאפשרת לכוון מתחת לזה.",
     [
         ("A", "שלוש נקודות — מה שבחרת", "אנחנו דואגים שכל פנייה שנכנסת אליךָ, אֶה... תקבל שיחה תוך דקה."),
         ("B", "נקודה", "אנחנו דואגים שכל פנייה שנכנסת אליךָ, אֶה. תקבל שיחה תוך דקה."),
         ("C", "פסיק", "אנחנו דואגים שכל פנייה שנכנסת אליךָ, אֶה, תקבל שיחה תוך דקה."),
         ("D", "תגית 0.25 שניות", 'אנחנו דואגים שכל פנייה שנכנסת אליךָ, אֶה <break time="0.25s"/> תקבל שיחה תוך דקה.'),
         ("E", "תגית 0.15 שניות", 'אנחנו דואגים שכל פנייה שנכנסת אליךָ, אֶה <break time="0.15s"/> תקבל שיחה תוך דקה.'),
     ]),
    ("wh", "2 · איפה זה שייך — ואיפה זה נשמע מזויף",
     "אמרת שזה צריך להיכנס \"במשפטים שנכון והגיוני שהיא תחשוב בהם ולא בדברים פשוטים\". "
     "אותה מילת היסוס בדיוק, בארבעה מקומות שונים בשיחה. **הכרטיס הזה הוא לא בחירה של הכי טוב** "
     "— סמן את זה שנשמע לךָ הכי נכון, וכתוב בתיבה אילו מהם נשמעים מזויפים. זה מה שהופך את זה לכלל.",
     [
         ("A", "שאלה שדורשת מחשבה — כמה זה עולה", "אז, אֶה... זה תלוי בכמה שיחות הסוכן מנהל בשבילךָ."),
         ("B", "בדיקה אמיתית — היומן", "רגע, אֶה... אני בודקת מה פנוי אצלו."),
         ("C", "משפט פשוט — אישור", "בטח, אֶה... אני רושמת את זה."),
         ("D", "פתיחה — ברכה", "שלום, אֶה... מדברת קרן מ-ClickScales."),
     ]),
    ("bk", "3 · אורך התגית בתשובה אמיתית",
     "התגית ניצחה את הכרטיס שלה ואומתה שהיא לא נאמרת בקול. עכשיו רק כמה. "
     "המשפט הוא הרגע שבו היא באמת הולכת לבדוק משהו — הרגע שהקוד יודע עליו בוודאות.",
     [
         ("A", "בלי — מה שיש היום", "רגע, אני בודקת את היומן."),
         ("B", "תגית 0.25 שניות", 'רגע <break time="0.25s"/> אני בודקת את היומן.'),
         ("C", "תגית 0.35 שניות — מה שניצח בסבב 16", 'רגע <break time="0.35s"/> אני בודקת את היומן.'),
         ("D", "תגית 0.5 שניות", 'רגע <break time="0.5s"/> אני בודקת את היומן.'),
     ]),
    ("eb", "4 · הפאוזה האמפתית — שוב, עם התגית",
     "בכרטיס 4 של סבב 16 לא בחרת אף אחד: פסיק, נקודה, שלוש נקודות ומקף נשמעו לךָ אותו דבר. "
     "כלומר למצב האמפתי אין כרגע שום מנגנון שנשמע. זו אותה שאלה עם הכלי היחיד שהוכח שעובד.",
     [
         ("A", "שלוש נקודות — מה שנשלח היום", "אני מבינה... זה באמת מתסכל."),
         ("B", "תגית 0.35 שניות", 'אני מבינה <break time="0.35s"/> זה באמת מתסכל.'),
         ("C", "תגית 0.5 שניות", 'אני מבינה <break time="0.5s"/> זה באמת מתסכל.'),
         ("D", "תגית אחרי המשפט, לפני השאלה", 'אני מבינה. זה באמת מתסכל <break time="0.5s"/> כמה פניות נכנסות אליךָ ביום?'),
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


def to_phone(src_path, out_path):
    """8kHz box-average — the same crude low-pass as the repo's own toPhoneRate.

    The phone clip decides, and on this page more than any other: a 0.15s tag and a 0.35s tag are
    separated by less than the difference the 8kHz band itself makes to how a silence reads.
    """
    pcm, rate = read_pcm(src_path)
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


def main():
    print(f"model: {synthmod.MODEL}  generation_config: {synthmod.GENERATION_CONFIG}")
    manifest = {"model": synthmod.MODEL, "generation_config": synthmod.GENERATION_CONFIG, "cards": []}
    for cid, title, note, variants in CARDS:
        card = {"id": cid, "title": title, "note": note, "variants": []}
        for key, label, text in variants:
            stem = f"r17_{cid}_{key}"
            studio = os.path.join(HERE, f"{stem}.wav")
            synthmod.synth(text, studio)
            wavcheck.assert_playable(studio)
            to_phone(studio, os.path.join(HERE, f"{stem}_phone.wav"))
            card["variants"].append({"key": key, "label": label, "text": text,
                                     "file": f"{stem}.wav", "phone": f"{stem}_phone.wav"})
            print(f"  {stem}  ok  (+phone)")
        manifest["cards"].append(card)
    json.dump(manifest, open(os.path.join(HERE, "round17.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("wrote round17.json")


if __name__ == "__main__":
    main()
