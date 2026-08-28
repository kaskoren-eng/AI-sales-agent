"""
Verification batch: does MINIMAL niqqud deliver the RIGHT gender when the gender is GIVEN
(as it will be from the CRM), for BOTH masculine and feminine?

Same 4 suffix words, once addressed to a man, once to a woman. Each: A plain vs B minimal niqqud.
Gender is supplied here (not inferred) — that's the production model: CRM knows, we mark.
"""
import json, os, struct, sys
sys.path.insert(0, ".")
from synth import synth

HERE = os.path.dirname(os.path.abspath(__file__))
KAMATZ, SHEVA, PATACH, HIRIQ = "ָ", "ְ", "ַ", "ִ"

def apply_marks(word, marks_by_idx):
    out = []
    for i, ch in enumerate(word):
        out.append(ch)
        if i in marks_by_idx:
            out.append(marks_by_idx[i])
    return "".join(out)

def masc(word):  # append kamatz to the final kaf -> "-kha"
    return apply_marks(word, {len(word) - 1: KAMATZ})

# feminine minimal niqqud, per word (correct Hebrew grammar for "-akh / -ayikh / -ekh")
FEM_RULES = {
    "שלך":  {1: KAMATZ, 2: SHEVA},              # שלָךְ   she-lakh
    "לך":   {0: KAMATZ, 1: SHEVA},              # לָךְ    lakh
    "אותך": {2: KAMATZ, 3: SHEVA},              # אותָךְ  o-takh
    "אליך": {1: PATACH, 2: HIRIQ, 3: SHEVA},    # אלַיִךְ  e-la-yikh
}
def fem(word):
    return apply_marks(word, FEM_RULES[word])

# (id, gender, target_word, sentence)
SENTENCES = [
    ("m1", "m", "שלך",  "מה השם שלך?"),
    ("m2", "m", "אליך", "אני אחזור אליך היום."),
    ("m3", "m", "אותך", "נעים מאוד להכיר אותך."),
    ("m4", "m", "לך",   "שלחתי לך עכשיו מייל."),
    ("f1", "f", "שלך",  "מה השם שלך?"),
    ("f2", "f", "אליך", "אני אחזור אליך היום."),
    ("f3", "f", "אותך", "נעים מאוד להכיר אותך."),
    ("f4", "f", "לך",   "שלחתי לך עכשיו מייל."),
]

def dur(path):
    b = open(path, "rb").read(); i = 12
    while i + 8 <= len(b):
        if b[i:i+4] == b"data": return (len(b) - (i + 8)) / 88200
        sz = struct.unpack("<I", b[i+4:i+8])[0]
        if sz == 0xFFFFFFFF or i+8+sz > len(b): break
        i += 8 + sz + (sz & 1)
    return (len(b) - 78) / 88200

def main():
    out = []
    for sid, g, word, plain in SENTENCES:
        fixed_word = masc(word) if g == "m" else fem(word)
        fixed = plain.replace(word, fixed_word, 1)
        pa, pb = f"v{sid}_A.wav", f"v{sid}_B.wav"
        synth(plain, os.path.join(HERE, pa)); synth(fixed, os.path.join(HERE, pb))
        row = {"id": sid, "gender": "זכר" if g == "m" else "נקבה", "word": word,
               "plain": plain, "fixed": fixed, "file_a": pa, "file_b": pb,
               "dur_a": round(dur(os.path.join(HERE, pa)), 2), "dur_b": round(dur(os.path.join(HERE, pb)), 2)}
        out.append(row)
        print(f"{sid} [{row['gender']}] {word} -> {fixed_word}   | {fixed}")
    json.dump(out, open(os.path.join(HERE, "verify.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("wrote verify.json")

if __name__ == "__main__":
    main()
