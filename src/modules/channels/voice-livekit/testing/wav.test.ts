import { describe, expect, it } from 'vitest';
import { assertPlayableWav, encodeWav, readWavHeader } from './wav.js';

/**
 * THE HEADER, AS A TEST — because 297 clips across every listening round shipped with a broken one
 * and nobody noticed until Koren could not play round 7.
 *
 * The defect itself was in the Python path (`tests/hebrew-tts-niqqud-ab/`, which wrote Cartesia's
 * streamed response bytes straight to disk, placeholder sizes and all). `encodeWav` has always been
 * correct. These tests exist so it stays that way, and so the reader of a future refactor knows the
 * two size fields are not decoration.
 */
describe('encodeWav — the file we hand a human is one a browser will decode', () => {
  const pcm = new Int16Array(800).fill(1234);

  it('writes real sizes in both fields, not the streaming placeholder', () => {
    const wav = encodeWav(pcm, 8_000);
    const h = readWavHeader(wav);
    expect(h.riffSize).toBe(wav.length - 8);
    expect(h.dataSize).toBe(wav.length - h.dataOffset);
    expect(h.dataSize).toBe(pcm.byteLength);
    expect(h.riffSize).not.toBe(0xffffffff);
  });

  it('validates what it produced before returning it', () => {
    expect(() => assertPlayableWav(encodeWav(pcm, 44_100))).not.toThrow();
  });
});

describe('assertPlayableWav — what it refuses', () => {
  const good = encodeWav(new Int16Array(400).fill(9), 8_000);

  it('refuses the 0xFFFFFFFF streaming placeholder — the exact byte pattern Cartesia sends', () => {
    // Verified 2026-08-31 against the live API: the first bytes of a /tts/bytes response are
    // `52 49 46 46 ff ff ff ff` and the `data` chunk size is 0xFFFFFFFF too.
    const broken = Buffer.from(good);
    broken.writeUInt32LE(0xffffffff, 4);
    expect(() => assertPlayableWav(broken)).toThrow(/placeholder/u);
  });

  it('refuses a data size that disagrees with the bytes on disk', () => {
    const broken = Buffer.from(good);
    broken.writeUInt32LE(12, 40);
    expect(() => assertPlayableWav(broken)).toThrow(/data size/u);
  });

  it('refuses a RIFF size that disagrees with the file length', () => {
    const broken = Buffer.from(good);
    broken.writeUInt32LE(good.length + 5000, 4);
    expect(() => assertPlayableWav(broken)).toThrow(/RIFF size/u);
  });

  it('refuses something that is not a WAV at all', () => {
    expect(() => assertPlayableWav(Buffer.from('not audio'))).toThrow(/RIFF\/WAVE/u);
  });
});

describe('readWavHeader — walks the chunk list', () => {
  it('finds `data` past a LIST/INFO chunk, which is what Cartesia puts there', () => {
    const base = encodeWav(new Int16Array(200).fill(7), 8_000);
    const list = Buffer.alloc(8 + 26);
    list.write('LIST', 0);
    list.writeUInt32LE(26, 4);
    const withList = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    withList.writeUInt32LE(withList.length - 8, 4);
    const h = readWavHeader(withList);
    expect(h.dataSize).toBe(400);
    expect(h.dataOffset).toBe(36 + list.length + 8);
    expect(() => assertPlayableWav(withList)).not.toThrow();
  });
});
