"""
Round 20 — breath harvesting and mixing, in numbers a TS mixer can copy verbatim.

The tag probe (probe20_tags.py + roundtrip20.ts, 2026-09-02) closed the tag route: of every
English non-verbal tag tried on Hebrew, only `[laughter]` renders (as a real "חח" laugh, both
sonic-3.5 and 3.6); every breath-shaped tag is inert, and the parenthesized form is READ ALOUD
("ברידס"). So a breath must be AUDIO WE SUPPLY, mixed into her stream — and this file is the
reference implementation of every number involved, kept in Python beside the listening round so
stage 2's `breath-mixer.ts` copies constants that were actually heard, not invented.

Three jobs:
  harvest  — scan a long TTS generation for non-lexical, low-energy segments between speech
             (DeepDub breathes on its own; Cartesia's [laughter] renders one laugh) and cut them
             out as candidate WAVs.
  splice   — insert a breath candidate into a Keren (Cartesia) clip at a sample offset, gained
             relative to the SPEECH RMS in dB. Phone-band audibility of a quiet breath is the
             round's biggest unknown, so the gain is a card variable, not a constant yet.
  measure  — RMS / peak / duration for any clip, so every card prints its numbers.

  python tests/hebrew-tts-niqqud-ab/breath_mix.py harvest dd_breath_src.wav

⚠️ THE SOURCE IS `dd_breath_src.wav`, NOT `dd_smoke.wav`. The 21s DeepDub generation the breath
candidates came from was originally written over `dd_smoke.wav` — a TRACKED 93KB fixture that
predates this work — which made a 2MB raw generation look like a modified test asset in every
`git status` and would have gone into a commit as one. `dd_smoke.wav` is back to its committed
contents; the generation lives under its own name and is deliberately NOT tracked, because 2MB of
raw TTS output is not worth the repo when `breaths/` already holds every harvested candidate.
"""
import os, struct, sys, wave

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME_MS = 10


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f"{path}: expected 16-bit PCM")
        rate, n, ch = w.getframerate(), w.getnframes(), w.getnchannels()
        pcm = list(struct.unpack(f"<{n * ch}h", w.readframes(n)))
    if ch == 2:
        pcm = [(pcm[i] + pcm[i + 1]) // 2 for i in range(0, len(pcm) - 1, 2)]
    return pcm, rate


def write_wav(path, pcm, rate):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack(f"<{len(pcm)}h", *[max(-32768, min(32767, int(s))) for s in pcm]))


def rms_frames(pcm, rate, frame_ms=FRAME_MS):
    spf = rate * frame_ms // 1000
    return [(sum(s * s for s in pcm[i:i + spf]) / spf) ** 0.5
            for i in range(0, len(pcm) - spf, spf)]


def speech_rms(pcm, rate):
    """RMS over speech-level frames only (>20% of peak frame) — the reference a breath is gained
    against. Whole-clip RMS would be dragged down by silence and make the breath too loud."""
    frames = rms_frames(pcm, rate)
    peak = max(frames) or 1.0
    speech = [f for f in frames if f > 0.20 * peak]
    return (sum(f * f for f in speech) / len(speech)) ** 0.5 if speech else peak


def gain_to_db(pcm, target_rms):
    cur = (sum(s * s for s in pcm) / len(pcm)) ** 0.5 or 1.0
    return target_rms / cur


def harvest(path, out_prefix="bcand"):
    """Cut every low-level, non-silent stretch of 120-700ms that sits between speech.

    'Low-level' is 2%-20% of the clip's peak frame — under 2% is line silence, over 20% is a word.
    The bounds are the same ones probe20_onset.py used to find the rendered laugh, so a candidate
    here is the same kind of object that analysis called 'low-level sound'.
    """
    pcm, rate = read_wav(os.path.join(HERE, path))
    frames = rms_frames(pcm, rate)
    peak = max(frames) or 1.0
    lo, hi = 0.02 * peak, 0.20 * peak
    spf = rate * FRAME_MS // 1000

    runs, start = [], None
    for i, f in enumerate(frames):
        if lo < f <= hi:
            if start is None:
                start = i
        else:
            if start is not None:
                runs.append((start, i))
                start = None
    if start is not None:
        runs.append((start, len(frames)))

    kept = 0
    for a, b in runs:
        ms = (b - a) * FRAME_MS
        if not (120 <= ms <= 700):
            continue
        seg = pcm[a * spf:b * spf]
        out = os.path.join(HERE, f"breaths/{out_prefix}_{a * FRAME_MS}ms_{ms}ms.wav")
        os.makedirs(os.path.dirname(out), exist_ok=True)
        write_wav(out, seg, rate)
        kept += 1
        print(f"candidate @{a * FRAME_MS}ms len={ms}ms -> {os.path.basename(out)}")
    print(f"{kept} candidate(s) from {path} ({rate}Hz, {len(pcm) * 1000 // rate}ms total)")


def resample(pcm, src_rate, dst_rate):
    """Nearest-sample resample — crude, but everything ends at 8kHz phone band anyway."""
    if src_rate == dst_rate:
        return list(pcm)
    n = int(len(pcm) * dst_rate / src_rate)
    return [pcm[min(len(pcm) - 1, int(i * src_rate / dst_rate))] for i in range(n)]


def splice(speech_path, breath_path, at_ms, breath_db, out_path, crossfade_ms=15):
    """Insert breath into speech at `at_ms`, gained `breath_db` dB relative to the speech RMS.

    INSERTED, not overlaid: production will do the same (frames enqueued between TTS frames), so
    the page must audition insertion. Short linear crossfades at both seams keep the splice from
    clicking — 15ms, under any audible gap.
    """
    speech, s_rate = read_wav(os.path.join(HERE, speech_path))
    breath, b_rate = read_wav(os.path.join(HERE, breath_path))
    breath = resample(breath, b_rate, s_rate)

    target = speech_rms(speech, s_rate) * (10 ** (breath_db / 20.0))
    g = gain_to_db(breath, target)
    breath = [s * g for s in breath]

    cf = int(s_rate * crossfade_ms / 1000)
    for i in range(min(cf, len(breath))):
        breath[i] *= i / cf
        breath[-1 - i] *= i / cf

    cut = int(s_rate * at_ms / 1000)
    write_wav(os.path.join(HERE, out_path), speech[:cut] + breath + speech[cut:], s_rate)
    print(f"{out_path}: breath {len(breath) * 1000 // s_rate}ms at {at_ms}ms, {breath_db:+.0f}dB rel speech")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "harvest":
        harvest(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "bcand")
    else:
        print(__doc__)
