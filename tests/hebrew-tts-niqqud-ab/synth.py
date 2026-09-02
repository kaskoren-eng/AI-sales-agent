"""
The synthesizer under every PYTHON listening round — now engine-aware, not Cartesia-only.

WHAT CHANGED (2026-09-02) AND WHY. This file used to be a Cartesia client, full stop, and 26 round
scripts import it. Koren's decision to move the agent to DeepDub therefore had a trap in it: the
instrument he judges every change with would have kept rendering CARTESIA clips for a DeepDub
agent — no error, no warning, nothing on the clip to say so — and his next verdict would have been
a verdict on the engine we are leaving. That is the same failure the TypeScript harness had, fixed
the same way (`testing/tts-engine.ts`).

HOW THE ENGINE IS CHOSEN, in order:
  1. `synthmod.ENGINE = "cartesia"` set by the round script — an EXPLICIT pin, always wins. This is
     how you reproduce an old round on the engine that produced it.
  2. `VOICE_TTS_PROVIDER` in `.env` — the same knob production reads.
  3. `cartesia` — production's own default, so nothing changes until the flip.

TWO CLIENTS, ONE `synth()`:
  - CARTESIA is a plain HTTP POST, so it stays here, over `curl --ssl-no-revoke` (this Windows box
    fails cert-revocation checks from Python's httpx/urllib; curl is the only client that works).
  - DEEPDUB is a per-generation WEBSOCKET with a socket pool, a generation-id router and an
    `isFinished` terminal, all already written in `tts/deepdub.tts.ts`. Reimplementing that here
    would be a second implementation of the protocol that decides what Koren hears, and a second
    implementation drifts. So it delegates to `tts_worker.ts`, which builds the engine through
    production's own `buildTTS()`. One long-lived child process per run, not one per clip.

`MODEL` and `GENERATION_CONFIG` ARE CARTESIA-SHAPED and every existing round script sets them.
Under a non-Cartesia engine they are REFUSED, loudly, rather than ignored: a round that silently
dropped `{"speed": 0.9, "volume": 1.4}` would produce clips that sound wrong for a reason nobody
could see, and "the fix did nothing" would be the conclusion. See `_reject_cartesia_only_knobs`.

The API key is read from `.env` at runtime and never written to disk.
"""
import atexit, json, os, re, subprocess, sys, tempfile

# Importable both as `python synth.py` and as `import synth` from a round script run from the
# repo root, where this directory is not otherwise on the path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wavcheck import finalize  # noqa: E402

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


def load_env(name, default=None):
    path = find_env()
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    if default is not None:
        return default
    raise SystemExit(f"{name} not found in {path}")

# --- engine selection -------------------------------------------------------------------------

#: Explicit pin by a round script. `None` = follow `.env`. Set to "cartesia" to reproduce a round
#: that was judged on Cartesia; the clips are only comparable to their verdicts on that engine.
ENGINE = None

_resolved_engine = None

def engine():
    """The engine this run will actually speak with. Resolved once, then cached."""
    global _resolved_engine
    if ENGINE:                      # an explicit pin overrides .env and re-pins on change
        return ENGINE
    if _resolved_engine is None:
        _resolved_engine = load_env("VOICE_TTS_PROVIDER", "cartesia").strip('"\'') or "cartesia"
    return _resolved_engine


def engine_label():
    """`cartesia/sonic-3.5` or `deepdub/dd-etts-3.2` — for manifests, filenames and page headers.

    Every round must be able to say on the page WHICH ENGINE spoke the clip. A verdict recorded
    against the wrong engine is worse than no verdict: it looks like evidence.
    """
    if engine() == "cartesia":
        return f"cartesia/{MODEL}"
    return f"{engine()}/{_worker_ready().get('model', 'unknown')}"

# --- Cartesia ---------------------------------------------------------------------------------

MODEL = "sonic-3"
# Production speaks at VOICE_TTS_SPEED / VOICE_TTS_VOLUME, and rounds 1-5 synthesized without
# them (i.e. at 1.0/1.0). Set this to {"speed": .., "volume": ..} to match the live agent — the
# same shape the LiveKit plugin sends for sonic-3 models on API 2025-04-16
# (node_modules/@livekit/agents-plugin-cartesia/dist/tts.js:572). None = the old behaviour, so
# every earlier round still reproduces byte-for-byte.
#
# CARTESIA-ONLY. DeepDub's per-generation protocol has no speed or volume parameter and we did not
# invent one; under `deepdub` these are refused, not ignored.
GENERATION_CONFIG = None
VERSION = "2025-04-16"
LANG = "he"
SAMPLE_RATE = 44100

_DEFAULT_MODEL = MODEL

def strip_pipe(niqqud):
    # Remove Phonikud's `|` prefix-boundary markers and tidy the spaces they leave.
    return re.sub(r"\s*\|\s*", "", niqqud)


def _reject_cartesia_only_knobs():
    """Refuse a Cartesia knob under an engine that cannot honour it. Loudly, not silently.

    A round script sets `MODEL = "sonic-3.5"` and `GENERATION_CONFIG = {"speed": 0.9, ...}` on its
    first two lines. Run that script after the flip and, without this, it would render DeepDub
    clips at DeepDub's own pacing while claiming in its docstring to be a Cartesia round at 0.9
    speed. The listener cannot hear the difference between "applied and made no difference" and
    "silently dropped", so the tool must not let the question arise.
    """
    eng = engine()
    if eng == "cartesia":
        return
    offenders = []
    if MODEL != _DEFAULT_MODEL:
        offenders.append(f'MODEL = {MODEL!r}')
    if GENERATION_CONFIG:
        offenders.append(f'GENERATION_CONFIG = {GENERATION_CONFIG!r}')
    if offenders:
        raise SystemExit(
            f"synth.py: engine is {eng!r}, but this round set Cartesia-only "
            f"{' and '.join(offenders)}.\n"
            f"  {eng} has no speed/volume parameter and does not know Cartesia's model names, and "
            f"silently ignoring them would produce clips that sound wrong for an invisible reason.\n"
            f"  To REPRODUCE the round on the engine it was judged on: set "
            f"`synthmod.ENGINE = \"cartesia\"` at the top of the script.\n"
            f"  To RE-ASK the question on {eng}: clear those two lines, and label the page with "
            f"synth.engine_label() so the verdicts are recorded against the right engine."
        )


def _synth_cartesia(text, out_path):
    payload = {
        "model_id": MODEL,
        "transcript": text,
        "voice": {"mode": "id", "id": load_env("CARTESIA_VOICE_ID_PRIMARY")},
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
            "-H", f"X-API-Key: {load_env('CARTESIA_API_KEY')}",
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
    finally:
        os.unlink(body_path)

# --- DeepDub (and any other engine production can build) --------------------------------------

_worker = None
_worker_banner = {}

#: Lines to skim past while hunting for the worker's reply before declaring it broken. Node writes
#: to stdout for reasons we do not control — a dotenv notice, a dependency's deprecation warning, a
#: tsx banner. One of those on the wrong line used to make a WORKING worker look dead, so this
#: reads until it finds the object it wants rather than demanding it be first.
_MAX_NOISE_LINES = 200


def _read_reply(proc, key, want=None):
    """Next stdout line that parses as a JSON object carrying `key`. Everything else is noise."""
    noise = []
    for _ in range(_MAX_NOISE_LINES):
        line = proc.stdout.readline()
        if not line:
            break
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            noise.append(line.rstrip())
            continue
        if isinstance(obj, dict) and key in obj:
            return obj
        noise.append(line.rstrip())
    tail = "\n  ".join(noise[-15:]) or "(nothing on stdout)"
    raise SystemExit(
        f"tts_worker.ts gave no {key!r} reply. Run it by hand to see why:\n"
        f"  npx tsx {os.path.join(HERE, 'tts_worker.ts')} --engine={want or engine()}\n"
        f"Last output:\n  {tail}"
    )

def _worker_ready():
    _start_worker()
    return _worker_banner


def _start_worker():
    """Launch `tts_worker.ts` once and keep it. It builds the engine via production's `buildTTS()`.

    One process per RUN, not per clip: the websocket connect is real, and paying it per clip would
    make the first clip of every A/B pair systematically slower than the second — an artefact in
    the instrument, on the exact axis some of these rounds are measuring.
    """
    global _worker, _worker_banner
    if _worker is not None:
        return _worker
    want = engine()
    # `--engine=` is a FLAG and not an env var on purpose: `loadEnv()` runs dotenv with
    # `override: true`, so exporting VOICE_TTS_PROVIDER for the child would be a silent no-op and
    # the pin would be lost between here and `buildTTS`.
    _worker = subprocess.Popen(
        ["npx", "tsx", os.path.join(HERE, "tts_worker.ts"), f"--engine={want}"],
        cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        text=True, encoding="utf-8", bufsize=1,
        shell=(os.name == "nt"),          # npx is a .cmd on Windows
    )
    atexit.register(_stop_worker)
    _worker_banner = _read_reply(_worker, "ready", want)
    got = _worker_banner.get("provider")
    # Trust the ENGINE THAT WAS BUILT, never the one that was requested. If they ever disagree, the
    # clips are mislabelled and the round is worthless — stop before rendering the first one.
    if got != want:
        _stop_worker()
        raise SystemExit(f"synth.py asked for {want!r} and tts_worker.ts built {got!r} — refusing to "
                         f"render clips that would be labelled with the wrong engine")
    print(f"engine: {got}/{_worker_banner.get('model')} @{_worker_banner.get('sampleRate')}Hz")
    return _worker


def _stop_worker():
    global _worker
    if _worker is None:
        return
    try:
        _worker.stdin.close()
        _worker.wait(timeout=10)
    except Exception:
        _worker.kill()
    finally:
        _worker = None


def _synth_worker(text, out_path):
    w = _start_worker()
    w.stdin.write(json.dumps({"text": text, "out": out_path}, ensure_ascii=False) + "\n")
    w.stdin.flush()
    res = _read_reply(w, "ok")
    if not res.get("ok"):
        raise SystemExit(f"synth failed for {out_path}: {res.get('error')}")

# --- the one entry point every round script calls ---------------------------------------------

def synth(text, out_path):
    _reject_cartesia_only_knobs()
    if engine() == "cartesia":
        _synth_cartesia(text, out_path)
    else:
        _synth_worker(text, out_path)
    # THE CLIP IS NOT FINISHED UNTIL ITS HEADER IS VALID. Cartesia's /tts/bytes response is a
    # STREAM, so it carries 0xFFFFFFFF in the RIFF and `data` size fields — the placeholder a
    # writer emits when it cannot seek back to patch the real length. We used to write those
    # bytes straight to disk and hand the file to Koren. Browsers disagree about such a file:
    # some play it, some play noise, some refuse, and none of them say why. Round 7 was 33
    # clips he could not play at all, and an earlier "the voice was not clear" report was
    # chased as a mixing bug while this was broken underneath it. See wavcheck.py.
    #
    # The worker path already writes real lengths, so this is a no-op there — kept unconditional
    # because ONE invariant ("nothing leaves synth() unplayable") is worth more than one saved
    # header read, and because the next engine added here will not remember to do it either.
    finalize(out_path)
    return os.path.getsize(out_path)


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
        # `engine` is a NEW field on each row rather than a new wrapper object around the list:
        # build_page.py, build_de_page.py and compute_de.py all read this file as a flat list, and
        # relabelling round 1 is not worth breaking three readers of a round already judged.
        manifest.append({"id": row["id"], "tag": row["tag"], "plain": a, "niqqud_clean": b,
                         "file_a": os.path.basename(pa), "file_b": os.path.basename(pb),
                         "bytes_a": sa, "bytes_b": sb, "engine": engine_label()})
        print(f"{row['id']} {row['tag']}: A={sa}B  B={sb}B  ok")
    json.dump(manifest, open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"wrote manifest.json  (engine: {engine_label()})")

if __name__ == "__main__":
    main()
