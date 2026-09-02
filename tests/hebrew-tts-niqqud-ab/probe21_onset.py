"""
Round 20 — what fills the extra time? Energy-envelope look at the flagged clips, no ear needed yet.

A prefix tag that RENDERS a breath should put a stretch of LOW-energy, noise-like audio before the
first word; a tag that is SPOKEN puts a full-energy word there; an inert tag changes nothing. This
reads the first 1.5s of each clip in 10ms RMS frames and prints where speech-level energy starts
and what sits before it, so the duration deltas from probe21_tags.py stop being ambiguous.

Also re-synthesizes the baseline twice per model to measure generation-to-generation duration
noise — a +240ms delta means nothing until the same text's natural spread is known
(phase-4-known-issues §9 says sonic-3.5 is deterministic-ish; 3.6 has never been measured here).

  python tests/hebrew-tts-niqqud-ab/probe21_onset.py
"""
import json, os, struct, sys, wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import synth as synthmod

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME_MS = 10

probe = json.load(open(os.path.join(HERE, "probe21.json"), encoding="utf-8"))
PLAIN = probe["sentence"]


def rms_frames(path):
    with wave.open(path, "rb") as w:
        rate, n = w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    pcm = struct.unpack(f"<{len(raw) // 2}h", raw)
    spf = rate * FRAME_MS // 1000
    frames = []
    for i in range(0, len(pcm) - spf, spf):
        chunk = pcm[i:i + spf]
        frames.append((sum(s * s for s in chunk) / spf) ** 0.5)
    return frames


def describe(path, label):
    frames = rms_frames(path)
    peak = max(frames) or 1.0
    # Speech onset: first frame at >20% of peak. Pre-onset content: anything 2%-20% is "breathy
    # noise" territory; <2% is silence.
    onset = next((i for i, f in enumerate(frames) if f > 0.20 * peak), None)
    if onset is None:
        print(f"{label}: no speech-level energy at all?!")
        return
    pre = frames[:onset]
    noisy = sum(1 for f in pre if 0.02 * peak < f <= 0.20 * peak)
    silent = sum(1 for f in pre if f <= 0.02 * peak)
    print(f"{label}: speech starts @{onset * FRAME_MS}ms — before it: "
          f"{noisy * FRAME_MS}ms low-level sound, {silent * FRAME_MS}ms silence")


def main():
    print("== onset anatomy (what sits before the first word) ==")
    for row in probe["results"]:
        if row.get("file") and row["key"] in ("A", "B", "C", "D", "E", "F"):
            describe(os.path.join(HERE, row["file"]), f"{row['model']} {row['key']} ({row['label']})")

    print("\n== duration noise floor (same text, fresh generations) ==")
    synthmod.GENERATION_CONFIG = {"speed": 0.9, "volume": 1.4}
    for model in ("sonic-3.5", "sonic-3.6"):
        synthmod.MODEL = model
        mkey = model.replace("sonic-3.", "m")
        for rep in (1, 2):
            out = os.path.join(HERE, f"r21_{mkey}_A_rep{rep}.wav")
            synthmod.synth(PLAIN, out)
            with wave.open(out, "rb") as w:
                ms = round(w.getnframes() / w.getframerate() * 1000)
            print(f"{model} baseline rep{rep}: {ms}ms")


if __name__ == "__main__":
    main()
