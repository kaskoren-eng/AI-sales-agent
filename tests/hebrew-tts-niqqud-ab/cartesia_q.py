"""Synthesize the Keren quality-test sentences with Cartesia sonic-3 (production voice), 24kHz."""
import json, os, subprocess, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))

def env(name):
    for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip()
    raise SystemExit(f"{name} missing")

API_KEY = env("CARTESIA_API_KEY")
VOICE = env("CARTESIA_VOICE_ID_PRIMARY")

def synth(text, out):
    payload = {
        "model_id": "sonic-3",
        "transcript": text,
        "voice": {"mode": "id", "id": VOICE},
        "language": "he",
        "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": 24000},
    }
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tf:
        json.dump(payload, tf, ensure_ascii=False)
        body = tf.name
    try:
        r = subprocess.run(
            ["curl", "-sS", "--ssl-no-revoke", "--fail-with-body", "-X", "POST",
             "https://api.cartesia.ai/tts/bytes",
             "-H", f"X-API-Key: {API_KEY}", "-H", "Cartesia-Version: 2025-04-16",
             "-H", "Content-Type: application/json", "--data-binary", f"@{body}", "-o", out],
            capture_output=True, text=True)
        if r.returncode != 0 or os.path.getsize(out) < 1000:
            raise SystemExit(f"cartesia failed {out}: {r.stderr[:200]}")
        return os.path.getsize(out)
    finally:
        os.unlink(body)

def main():
    rows = json.load(open(os.path.join(HERE, "q_sentences.json"), encoding="utf-8"))
    for r in rows:
        out = os.path.join(HERE, f"ct_q{r['id']}.wav")
        n = synth(r["text"], out)
        print(f"ct_q{r['id']} {r['tag']}: {n} bytes")
    print("cartesia done")

if __name__ == "__main__":
    main()
