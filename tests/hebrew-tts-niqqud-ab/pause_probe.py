"""
Round 6, item 6 — the OBJECTIVE half of "the commas do not produce pauses".

An ear can say "it does not flow". It cannot say whether a comma produced 40ms or 300ms of
silence, and that is the difference between "sonic-3.5 ignores our punctuation" and "sonic-3.5
pauses fine and something else is wrong". So this measures it: 10ms RMS frames, a threshold
relative to the clip's own loudness, and every internal silence run reported with its length and
where in the clip it sits.

Leading and trailing silence are excluded — they are the encoder's, not the sentence's.

It measures BOTH families of clip:
  r6_ps1_A.wav   one-shot /tts/bytes, the whole sentence in one request  (round6.py)
  r6_ps1_AS.wav  the agent's own Cartesia websocket stream               (pause-stream-probe.ts)
so the side-by-side answers which of the two is losing the pause. Results are written back into
round6.json (`gaps`, `speechMs`, `durMs` per variant) and rendered on the listening page, so the
numbers sit next to the audio they describe.

  python tests/hebrew-tts-niqqud-ab/pause_probe.py
"""
import json, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))

FRAME_MS = 10
# A pause a listener notices. Below this it is co-articulation, not a beat.
MIN_GAP_MS = 90
# Silence is relative to the clip: sonic-3.5's floor moves with volume, and round 6 synthesizes at
# volume 1.4. 4% of peak is comfortably below any voiced Hebrew and above the noise floor.
SILENCE_RATIO = 0.04


def read_wav(path):
    """(pcm as a list of ints, sample_rate). Parses the header rather than assuming 44.1k — the
    streamed clips come from the plugin at its own rate."""
    b = open(path, "rb").read()
    if b[:4] != b"RIFF":
        raise SystemExit(f"not a wav: {path}")
    rate, i = None, 12
    while i + 8 <= len(b):
        cid, sz = b[i:i + 4], struct.unpack("<I", b[i + 4:i + 8])[0]
        if cid == b"fmt ":
            rate = struct.unpack("<I", b[i + 12:i + 16])[0]
        elif cid == b"data":
            n = min(sz, len(b) - (i + 8))
            n -= n % 2
            return struct.unpack(f"<{n // 2}h", b[i + 8:i + 8 + n]), rate
        if sz == 0xFFFFFFFF or i + 8 + sz > len(b):
            break
        i += 8 + sz + (sz & 1)
    raise SystemExit(f"no data chunk: {path}")


def gaps(path):
    pcm, rate = read_wav(path)
    per = max(1, rate * FRAME_MS // 1000)
    frames = []
    for s in range(0, len(pcm) - per + 1, per):
        acc = 0
        for x in pcm[s:s + per]:
            acc += x * x
        frames.append((acc / per) ** 0.5)
    if not frames:
        return {"durMs": 0, "speechMs": 0, "gaps": []}
    peak = max(frames)
    thresh = peak * SILENCE_RATIO
    loud = [f > thresh for f in frames]
    if not any(loud):
        return {"durMs": len(frames) * FRAME_MS, "speechMs": 0, "gaps": []}
    first, last = loud.index(True), len(loud) - 1 - loud[::-1].index(True)

    out, run = [], 0
    for i in range(first, last + 1):
        if loud[i]:
            if run * FRAME_MS >= MIN_GAP_MS:
                out.append({"atMs": (i - run - first) * FRAME_MS, "ms": run * FRAME_MS})
            run = 0
        else:
            run += 1
    return {
        "durMs": len(frames) * FRAME_MS,
        "speechMs": (last - first + 1) * FRAME_MS,
        "gaps": out,
    }


def main():
    path = os.path.join(HERE, "round6.json")
    data = json.load(open(path, encoding="utf-8"))
    rows = []
    for card in data["cards"]:
        if card["section"] != "ps":
            continue
        # Idempotent: a re-run re-measures in place instead of appending a second copy of the
        # streamed variants.
        card["variants"] = [v for v in card["variants"] if not v["key"].endswith("S")]
        extra = []
        for v in card["variants"]:
            for key, file, how in (
                (v["key"], v["file"], "one-shot"),
                (v["key"] + "S", f"r6_{card['id']}_{v['key']}S.wav", "stream"),
            ):
                p = os.path.join(HERE, file)
                if not os.path.exists(p):
                    continue
                m = gaps(p)
                target = v if key == v["key"] else None
                if target is None:
                    extra.append({**{k: v[k] for k in ("key", "label", "text")},
                                  "key": key, "label": v["label"] + " · זרימה (כמו בשיחה)",
                                  "file": file, "dur": round(m["durMs"] / 1000, 2), **m})
                else:
                    v.update(m)
                rows.append((card["id"], key, how, m))
        card["variants"].extend(extra)
    json.dump(data, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)

    w = max(len(f"{c}_{k}") for c, k, _, _ in rows) if rows else 10
    print(f"{'clip'.ljust(w)}  {'path'.ljust(9)}  {'speech':>7}  {'pauses':>6}  gaps (ms @ ms)")
    for cid, key, how, m in rows:
        g = ", ".join(f"{x['ms']}@{x['atMs']}" for x in m["gaps"]) or "-"
        print(f"{f'{cid}_{key}'.ljust(w)}  {how.ljust(9)}  {m['speechMs']:>6}m  {len(m['gaps']):>6}  {g}")
    print("\nwrote gaps back into round6.json")


if __name__ == "__main__":
    main()
