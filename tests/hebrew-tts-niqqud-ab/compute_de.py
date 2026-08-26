"""
Two NEW ways to use Phonikud — as an ORACLE, not as a niqqud source for the TTS.

D — Phonikud decides the gender of each ambiguous 2nd-person word from context, and we
    emit a PLAIN-LETTER phonetic respelling (שלך→שלכה masc / שלאך fem). Zero niqqud reaches
    sonic-3. Generalizes speech-guard.ts::forceMasculineAddress (context-aware + feminine).

E — SELECTIVE niqqud: niqqud ONLY on the ambiguous word, the rest of the sentence plain.
    Tests whether a little niqqud is tolerable, unlike B/C which niqqud'd every word.

Only sentences that actually contain an ambiguous suffix change; the rest are identical to A.
"""
import json, os, re, sys, struct
sys.path.insert(0, ".")
from synth import synth

HERE = os.path.dirname(os.path.abspath(__file__))

# plain-letter respellings — masculine matches forceMasculineAddress; feminine forces "-akh".
MASC = {"שלך":"שלכה","לך":"לכה","אותך":"אותכה","אליך":"אליכה","איתך":"איתכה","בשבילך":"בשבילכה","עבורך":"עבורכה"}
FEM  = {"שלך":"שלאך","לך":"לאך","אותך":"אותאך","אליך":"אלייך","איתך":"איתאך","בשבילך":"בשבילאך","עבורך":"עבוראך"}
TARGETS = set(MASC)

MARK = lambda ch: 0x0591 <= ord(ch) <= 0x05C7
KAMATZ, SHEVA = "ָ", "ְ"

def strip_all_marks(tok):
    return "".join(ch for ch in tok if not MARK(ch))

def strip_nonstd(tok):
    # keep standard niqqud (05B0-05BC,05C1,05C2), drop OLE/METEG/cantillation and '|'
    out = []
    for ch in tok:
        cp = ord(ch)
        if ch == "|": continue
        if 0x0591 <= cp <= 0x05C7 and not (0x05B0 <= cp <= 0x05BC or cp in (0x05C1, 0x05C2)):
            continue
        out.append(ch)
    return "".join(out)

PUNCT = set(" ,.?!:;\"'()[]—–-…׃\n\t\r")

def split_core(tok):
    # Strip only real punctuation/space. NEVER strip Hebrew combining marks —
    # the final kamatz (U+05B8) that marks the masculine "-kha" is a trailing
    # combining mark, and a \W-based strip silently ate it (the "niqqud wrong" bug).
    i, j = 0, len(tok)
    while i < j and tok[i] in PUNCT: i += 1
    while j > i and tok[j-1] in PUNCT: j -= 1
    return tok[:i], tok[i:j], tok[j:]

def minimal_niqqud(plain_core, gender):
    # Add ONLY the disambiguating vowel on the final kaf; nothing else.
    i = plain_core.rfind("ך")
    if i == -1: i = plain_core.rfind("כ")
    if i == -1: return plain_core
    vowel = KAMATZ if gender == "m" else SHEVA  # kamatz => "-kha" (masc)
    return plain_core[:i+1] + vowel + plain_core[i+1:]

def gender_of(dia_tok):
    i = dia_tok.rfind("ך")
    if i == -1: return "m"
    after = dia_tok[i+1:i+2]
    if after == KAMATZ: return "m"
    if after == SHEVA:  return "f"
    return "m"  # default masculine per prompt

def build(plain, niqqud_full):
    # align plain tokens to Phonikud tokens by consonant skeleton
    p_tokens = plain.split()
    d_tokens = [t for t in niqqud_full.replace("|", "").split()]
    d_by_skel = {}
    for dt in d_tokens:
        d_by_skel.setdefault(strip_all_marks(split_core(dt)[1]), []).append(dt)
    d_out, e_out, f_out = [], [], []
    changed = False
    for pt in p_tokens:
        pre, core, post = split_core(pt)
        if core in TARGETS:
            changed = True
            cands = d_by_skel.get(core) or []
            dtok = cands.pop(0) if cands else core
            g = gender_of(dtok)
            d_word = (MASC if g == "m" else FEM)[core]
            e_word = strip_nonstd(split_core(dtok)[1]) or core   # full standard niqqud, done right
            f_word = minimal_niqqud(core, g)                      # ONE disambiguating vowel only
            d_out.append(pre + d_word + post)
            e_out.append(pre + e_word + post)
            f_out.append(pre + f_word + post)
        else:
            d_out.append(pt); e_out.append(pt); f_out.append(pt)
    return " ".join(d_out), " ".join(e_out), " ".join(f_out), changed

def dur(path):
    b = open(path, "rb").read(); i = 12
    while i+8 <= len(b):
        if b[i:i+4] == b"data": return (len(b)-(i+8))/88200
        sz = struct.unpack("<I", b[i+4:i+8])[0]
        if sz == 0xFFFFFFFF or i+8+sz > len(b): break
        i += 8 + sz + (sz & 1)
    return (len(b)-78)/88200

def main():
    dia = json.load(open(os.path.join(HERE, "diacritized.json"), encoding="utf-8"))
    man = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))
    mi = {r["id"]: r for r in man}
    for r in dia:
        e = mi[r["id"]]
        d_text, e_text, f_text, changed = build(r["plain"], r["niqqud"])
        e["text_d"], e["text_e"], e["text_f"], e["de_changed"] = d_text, e_text, f_text, changed
        if changed:
            pd, pe, pf = f"{r['id']}_D.wav", f"{r['id']}_E.wav", f"{r['id']}_F.wav"
            synth(d_text, os.path.join(HERE, pd)); synth(e_text, os.path.join(HERE, pe)); synth(f_text, os.path.join(HERE, pf))
            e["file_d"], e["file_e"], e["file_f"] = pd, pe, pf
            e["dur_d"] = round(dur(os.path.join(HERE, pd)),2)
            e["dur_e"] = round(dur(os.path.join(HERE, pe)),2)
            e["dur_f"] = round(dur(os.path.join(HERE, pf)),2)
            print(f"{r['id']} CHANGED")
            print(f"   D: {d_text}   ({e['dur_d']}s)")
            print(f"   E: {e_text}   ({e['dur_e']}s)")
            print(f"   F: {f_text}   ({e['dur_f']}s)")
        else:
            e["file_d"] = e["file_e"] = e["file_f"] = e["file_a"]
            e["dur_d"] = e["dur_e"] = e["dur_f"] = e["dur_a"]
            print(f"{r['id']} = A (no ambiguous suffix)")
    json.dump(man, open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("updated manifest.json")

if __name__ == "__main__":
    main()
