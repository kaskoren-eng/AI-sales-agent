"""
Mixed-gender test: sentences that address BOTH a man and a woman with 2nd-person suffixes.
This is where Phonikud-as-oracle earns its keep — the static masculine rule can't do it.

Per sentence, 3 deliveries:
  A  plain (ambiguous — must sound wrong for at least one of the two)
  D  Phonikud decides gender per word -> PLAIN respelling (masc שלכה / fem שלאך), 0 niqqud
  G  Phonikud decides gender per word -> SMART niqqud:
        masc = minimal (kamatz on final kaf: שלךָ  — the variant Koren picked)
        fem  = full standard niqqud from Phonikud (שֶׁלָּךְ)
"""
import json, os, re, struct, sys
sys.path.insert(0, ".")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
import phonikud_onnx.model as _m
from tokenizers import Tokenizer as _T
_m.Tokenizer.from_pretrained = staticmethod(lambda name: _T.from_file("tokenizer.json"))
from phonikud_onnx import Phonikud
from synth import synth

HERE = os.path.dirname(os.path.abspath(__file__))

# Each sentence addresses a man, then a woman. Strong gender cues (את/אתה, gendered
# adjectives) in some; name-only in others — to see if Phonikud needs the strong cue.
SENTENCES = [
    ("m1", "אתה רוצה שאשלח לך הודעה? ואת, רוצה שאשלח לך גם?"),
    ("m2", "אדוני, נעים להכיר אותך. גברתי, נעים להכיר אותך."),
    ("m3", "רון, אתה מוזמן ואחזור אליך בקרוב. נועה, את מוזמנת ואחזור אליך בקרוב."),
    ("m4", "יוסי, מה מספר הטלפון שלך? מיכל, ומה המייל שלך?"),
    ("m5", "דני, זה בשבילך במתנה. שרה, וזה בשבילך."),
    ("m6", "קורן, תודה לך על הזמן. דנה, ותודה גם לך."),
]

MASC = {"שלך":"שלכה","לך":"לכה","אותך":"אותכה","אליך":"אליכה","איתך":"איתכה","בשבילך":"בשבילכה","עבורך":"עבורכה"}
FEM  = {"שלך":"שלאך","לך":"לאך","אותך":"אותאך","אליך":"אלייך","איתך":"איתאך","בשבילך":"בשבילאך","עבורך":"עבוראך"}
TARGETS = set(MASC)
KAMATZ = "ָ"; SHEVA = "ְ"
PUNCT = set(" ,.?!:;\"'()[]—–-…׃\n\t\r")
MARK = lambda ch: 0x0591 <= ord(ch) <= 0x05C7

def split_core(tok):
    i, j = 0, len(tok)
    while i < j and tok[i] in PUNCT: i += 1
    while j > i and tok[j-1] in PUNCT: j -= 1
    return tok[:i], tok[i:j], tok[j:]

def strip_marks(tok): return "".join(c for c in tok if not MARK(c))

def strip_nonstd(tok):
    out = []
    for ch in tok:
        cp = ord(ch)
        if ch == "|": continue
        if 0x0591 <= cp <= 0x05C7 and not (0x05B0 <= cp <= 0x05BC or cp in (0x05C1, 0x05C2)): continue
        out.append(ch)
    return "".join(out)

def gender_of(dia_tok):
    i = dia_tok.rfind("ך")
    if i == -1: return "m"
    a = dia_tok[i+1:i+2]
    if a == KAMATZ: return "m"
    if a == SHEVA:  return "f"
    return "m"

def minimal_masc(core):
    i = core.rfind("ך")
    return core[:i+1] + KAMATZ + core[i+1:] if i != -1 else core

def dur(path):
    b = open(path, "rb").read(); i = 12
    while i+8 <= len(b):
        if b[i:i+4] == b"data": return (len(b)-(i+8))/88200
        sz = struct.unpack("<I", b[i+4:i+8])[0]
        if sz == 0xFFFFFFFF or i+8+sz > len(b): break
        i += 8 + sz + (sz & 1)
    return (len(b)-78)/88200

def build(plain, dia_full):
    d_by_skel = {}
    for dt in dia_full.replace("|", "").split():
        d_by_skel.setdefault(strip_marks(split_core(dt)[1]), []).append(dt)
    d_out, g_out, decisions = [], [], []
    for pt in plain.split():
        pre, core, post = split_core(pt)
        if core in TARGETS:
            dtok = (d_by_skel.get(core) or [core]).pop(0) if d_by_skel.get(core) else core
            g = gender_of(dtok)
            d_word = (MASC if g == "m" else FEM)[core]
            g_word = minimal_masc(core) if g == "m" else (strip_nonstd(split_core(dtok)[1]) or core)
            d_out.append(pre + d_word + post); g_out.append(pre + g_word + post)
            decisions.append(f"{core}->{g}")
        else:
            d_out.append(pt); g_out.append(pt)
    return " ".join(d_out), " ".join(g_out), decisions

def main():
    p = Phonikud("phonikud-1.0.int8.onnx")
    out = []
    for sid, text in SENTENCES:
        dia = p.add_diacritics(text)
        d_text, g_text, dec = build(text, dia)
        pa, pd, pg = f"{sid}_A.wav", f"{sid}_D.wav", f"{sid}_G.wav"
        synth(text, os.path.join(HERE, pa)); synth(d_text, os.path.join(HERE, pd)); synth(g_text, os.path.join(HERE, pg))
        row = {"id": sid, "plain": text, "text_d": d_text, "text_g": g_text, "decisions": dec,
               "file_a": pa, "file_d": pd, "file_g": pg,
               "dur_a": round(dur(os.path.join(HERE, pa)),2),
               "dur_d": round(dur(os.path.join(HERE, pd)),2),
               "dur_g": round(dur(os.path.join(HERE, pg)),2)}
        out.append(row)
        print(f"{sid}  decisions={dec}")
        print(f"   D: {d_text}")
        print(f"   G: {g_text}")
    json.dump(out, open(os.path.join(HERE, "mixed.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("wrote mixed.json")

if __name__ == "__main__":
    main()
