# Hebrew TTS niqqud A/B — Cartesia sonic-3 + Phonikud

Does feeding Cartesia sonic-3 **diacriticized** Hebrew (niqqud, via Phonikud) pronounce
names / numbers / mixed-English better than the plain text we send today?

## Listen & judge

Open **`index.html`** in a browser. For each of 10 sentences you hear:

- **A** — plain text, exactly what the agent sends today
- **B** — the same text after `Phonikud.add_diacritics()`

Mark which is better; the page tallies and gives you a copyable summary.

## How B is produced

1. `Phonikud.add_diacritics()` adds niqqud **plus** U+05AB stress marks (Phonikud's
   TTS-oriented output — not plain dictionary niqqud).
2. We strip only Phonikud's `|` morpheme-boundary marker, because sonic-3 was not
   trained on that convention. Vowel points and stress marks are kept and sent to
   Cartesia as ordinary UTF-8 — no API change needed if we adopt this.

## Reproduce

```bash
pip install phonikud phonikud-onnx           # both CC-BY-4.0 (commercial OK w/ attribution)
curl -L --ssl-no-revoke -o phonikud-1.0.int8.onnx \
  https://huggingface.co/Phonikud/phonikud-onnx/resolve/main/phonikud-1.0.int8.onnx
python -c "..."   # diacritize (see git history / the one-liner used)
python synth.py        # calls Cartesia /tts/bytes (key read from ../../.env)
python build_page.py   # regenerates index.html from manifest.json
```

## Files

- `sentences.py` — the 10 test sentences (from the Keren v2 prompt)
- `diacritized.json` — plain + Phonikud niqqud for each
- `synth.py` — Cartesia sonic-3 synthesizer (A + B → WAV)
- `manifest.json` — per-sentence text, filenames, durations
- `build_page.py` → `index.html` — the listening page
- `NN_A.wav` / `NN_B.wav` — the audio

## Observation before you listen

The niqqud (B) clips are **generally longer** than plain (B/A ≈ 1.3–2.4×), i.e. sonic-3
enunciates more fully with niqqud — except #07, where the *plain* clip was long/stuttery
and niqqud was shorter. If B wins on quality, weigh this timing cost against latency;
production runs over an 8kHz phone line, while these samples are 44.1kHz full quality.

## Attribution (CC-BY-4.0)

Diacritization by **Phonikud** and its ONNX model (`phonikud`, `phonikud-onnx`),
© the Phonikud project — https://github.com/phonikud — licensed CC-BY-4.0.
Tokenizer: `dicta-il/dictabert-large-char-menaked`.
