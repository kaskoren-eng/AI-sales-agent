"""
Cartesia sonic-3 A/B synthesizer for the niqqud experiment.

For each of the 10 sentences produces two WAV files:
  NN_A.wav  — plain text, exactly as the agent sends today
  NN_B.wav  — Phonikud-diacritized text (the `|` morpheme-boundary marker stripped,
              since Cartesia's sonic-3 is not trained on that Phonikud-TTS convention;
              the niqqud vowel points and the U+05AB stress marks are kept)

HTTP goes through curl --ssl-no-revoke: this Windows box fails cert-revocation checks
from Python's httpx/urllib, and curl is the only client that works reliably here.
The Cartesia key is read from .env at runtime and never written to disk.
"""
import json, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

def find_env():
    """The nearest `.env` at or above the repo root.

    A git WORKTREE has no `.env` — it is gitignored, so it lives only in the main checkout, three
    directories above `.claude/worktrees/<name>/`. Without this walk every round of this experiment
    is unrunnable from a worktree, which is where the voice sessions actually work. Never copy the
    file into the worktree instead: `.gitignore` covers `.env*`, but a copied secret is one bad
    `git add -f` away from the history.
    """
    d = ROOT
    while True:
        candidate = os.path.join(d, ".env")
        if os.path.exists(candidate):
            return candidate
        parent = os.path.dirname(d)
        if parent == d:
            raise SystemExit(f"no .env found at or above {ROOT}")
        d = parent


def load_env(name):
    path = find_env()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    raise SystemExit(f"{name} not found in {path}")

API_KEY = load_env("CARTESIA_API_KEY")
VOICE_ID = load_env("CARTESIA_VOICE_ID_PRIMARY")
MODEL = "sonic-3"
# Production speaks at VOICE_TTS_SPEED / VOICE_TTS_VOLUME, and rounds 1-5 synthesized without
# them (i.e. at 1.0/1.0). Set this to {"speed": .., "volume": ..} to match the live agent — the
# same shape the LiveKit plugin sends for sonic-3 models on API 2025-04-16
# (node_modules/@livekit/agents-plugin-cartesia/dist/tts.js:572). None = the old behaviour, so
# every earlier round still reproduces byte-for-byte.
GENERATION_CONFIG = None
VERSION = "2025-04-16"
LANG = "he"
SAMPLE_RATE = 44100

def strip_pipe(niqqud):
    # Remove Phonikud's `|` prefix-boundary markers and tidy the spaces they leave.
    return re.sub(r"\s*\|\s*", "", niqqud)

def synth(text, out_path):
    payload = {
        "model_id": MODEL,
        "transcript": text,
        "voice": {"mode": "id", "id": VOICE_ID},
        "language": LANG,
        "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": SAMPLE_RATE},
    }
    if GENERATION_CONFIG:
        payload["generation_config"] = GENERATION_CONFIG
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tf:
        json.dump(payload, tf, ensure_ascii=False)
        body_path = tf.name
    try:
        cmd = [
            "curl", "-sS", "--ssl-no-revoke", "--fail-with-body",
            "-X", "POST", "https://api.cartesia.ai/tts/bytes",
            "-H", f"X-API-Key: {API_KEY}",
            "-H", f"Cartesia-Version: {VERSION}",
            "-H", "Content-Type: application/json",
            "--data-binary", f"@{body_path}",
            "-o", out_path,
        ]
        r = subprocess.run(cmd, capture_output=True, text=True)
        ok = r.returncode == 0 and os.path.exists(out_path) and os.path.getsize(out_path) > 1000
        if not ok:
            head = b""
            if os.path.exists(out_path):
                head = open(out_path, "rb").read(300)
            raise SystemExit(f"synth failed for {out_path}: rc={r.returncode} err={r.stderr[:200]} body={head[:200]!r}")
        return os.path.getsize(out_path)
    finally:
        os.unlink(body_path)

def main():
    data = json.load(open(os.path.join(HERE, "diacritized.json"), encoding="utf-8"))
    manifest = []
    for row in data:
        a = row["plain"]
        b = strip_pipe(row["niqqud"])
        pa = os.path.join(HERE, f"{row['id']}_A.wav")
        pb = os.path.join(HERE, f"{row['id']}_B.wav")
        sa = synth(a, pa)
        sb = synth(b, pb)
        manifest.append({"id": row["id"], "tag": row["tag"], "plain": a, "niqqud_clean": b,
                         "file_a": os.path.basename(pa), "file_b": os.path.basename(pb),
                         "bytes_a": sa, "bytes_b": sb})
        print(f"{row['id']} {row['tag']}: A={sa}B  B={sb}B  ok")
    json.dump(manifest, open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print("wrote manifest.json")

if __name__ == "__main__":
    main()
