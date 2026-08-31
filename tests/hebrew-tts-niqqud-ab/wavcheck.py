"""
Every WAV this experiment writes is checked before anyone is asked to listen to it.

WHY THIS FILE EXISTS. Round 7 was 33 clips, nine sections and a page built to settle nine notes
from a production call, and Koren could not play a single one of them. Every clip in every round
since round 1 — 297 files — carried `0xFFFFFFFF` in BOTH the `RIFF` chunk size and the `data` chunk
size. That is the streaming placeholder a writer emits when its output is a pipe and it cannot seek
back to patch the real length, and Cartesia's `/tts/bytes` response is exactly that: a stream. We
wrote the response bytes straight to disk, so we inherited it.

Browsers disagree about such a file. Some play it, some play noise, some refuse outright, and
NONE of them report an error you would see. It also sent an earlier diagnosis down the wrong path —
"the first variants on the A/B page were broken, the voice was not clear at all" was investigated
as a mixing bug (which was real, and separately fixed) while these headers were broken underneath
it the whole time and nobody checked.

THE LESSON, AND IT IS THE POINT OF THIS MODULE: a cheap assertion — *the file I just wrote has a
valid header* — belongs at the moment of writing, not in a repair script run after a wasted round.
`synth()` calls `finalize()` on every clip it produces, so a future round is born correct.

The audio bytes are never touched. Only the two size fields are rewritten, from the real length of
the file, by walking the chunk list so a `LIST`/`INFO` chunk of any size is handled.
"""
import os
import struct


class WavHeaderError(Exception):
    """The file on disk is not something a browser can be trusted to play."""


def read_header(path):
    """Everything that matters about a WAV header, read off the bytes on disk.

    Returns a dict: file_size, riff_size, chunks (ordered list of (id, declared_size, offset)),
    data_offset, data_size, plus `placeholder` — True when either size field is the 0xFFFFFFFF
    streaming placeholder.
    """
    with open(path, "rb") as f:
        raw = f.read()
    if len(raw) < 12 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise WavHeaderError(f"{os.path.basename(path)}: not a RIFF/WAVE file")

    riff_size = struct.unpack_from("<I", raw, 4)[0]
    chunks = []
    data_offset = None
    data_size = None
    i = 12
    while i + 8 <= len(raw):
        cid = raw[i : i + 4]
        size = struct.unpack_from("<I", raw, i + 4)[0]
        chunks.append((cid.decode("latin1"), size, i))
        if cid == b"data":
            data_offset = i + 8
            data_size = size
            break
        # A placeholder or an over-long size means the chunk list cannot be walked any further;
        # stop rather than seek past the end of the buffer.
        if size == 0xFFFFFFFF or i + 8 + size > len(raw):
            break
        i += 8 + size + (size & 1)

    return {
        "path": path,
        "file_size": len(raw),
        "riff_size": riff_size,
        "chunks": chunks,
        "data_offset": data_offset,
        "data_size": data_size,
        "placeholder": riff_size == 0xFFFFFFFF or data_size == 0xFFFFFFFF,
    }


def repair(path):
    """Rewrites the two size fields from the real file length. Returns True if anything changed.

    Idempotent: a file whose sizes already agree with its length is left byte-for-byte alone.
    """
    info = read_header(path)
    if info["data_offset"] is None:
        raise WavHeaderError(f"{os.path.basename(path)}: no `data` chunk found")

    real_riff = info["file_size"] - 8
    real_data = info["file_size"] - info["data_offset"]
    if info["riff_size"] == real_riff and info["data_size"] == real_data:
        return False

    with open(path, "r+b") as f:
        f.seek(4)
        f.write(struct.pack("<I", real_riff))
        f.seek(info["data_offset"] - 4)
        f.write(struct.pack("<I", real_data))
    return True


def assert_playable(path):
    """Raises unless the file on disk is one a browser will decode. Read back, never assumed."""
    info = read_header(path)
    name = os.path.basename(path)
    if info["placeholder"]:
        raise WavHeaderError(f"{name}: streaming placeholder (0xFFFFFFFF) still in a size field")
    if info["data_offset"] is None:
        raise WavHeaderError(f"{name}: no `data` chunk found")
    if info["riff_size"] != info["file_size"] - 8:
        raise WavHeaderError(
            f"{name}: RIFF size {info['riff_size']} != file length - 8 ({info['file_size'] - 8})"
        )
    expected_data = info["file_size"] - info["data_offset"]
    if info["data_size"] != expected_data:
        raise WavHeaderError(
            f"{name}: data size {info['data_size']} != bytes after the header ({expected_data})"
        )
    if info["data_size"] == 0:
        raise WavHeaderError(f"{name}: zero audio bytes")
    return info


def finalize(path):
    """Repair, then verify. The one call a writer makes; it raises rather than warn.

    Raising is deliberate. A warning printed into a run that synthesizes thirty clips is a warning
    nobody reads, and the cost of noticing late is a whole listening round — which is what happened.
    """
    repaired = repair(path)
    assert_playable(path)
    return repaired
