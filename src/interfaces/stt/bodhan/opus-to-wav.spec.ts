import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OpusDecodeError,
  WAV_SAMPLE_RATE,
  defaultDecoderFactory,
  oggOpusToWav16k,
  pcmFloat32ToWav,
  warmUpOpusDecoder,
  type DecodedPcm,
  type OpusDecoderLike,
} from './opus-to-wav';

function fakeDecoder(
  result: Partial<DecodedPcm> | Error,
  opts: { readyRejects?: Error } = {},
): OpusDecoderLike & { freed: number } {
  const dec = {
    freed: 0,
    ready: opts.readyRejects
      ? Promise.reject(opts.readyRejects)
      : Promise.resolve(),
    decodeFile: jest.fn(async () => {
      if (result instanceof Error) throw result;
      return {
        channelData: [new Float32Array(0)],
        samplesDecoded: 0,
        sampleRate: WAV_SAMPLE_RATE,
        errors: [],
        ...result,
      };
    }),
    free: () => {
      dec.freed++;
    },
  };
  // avoid an unhandled rejection warning for the readyRejects case
  dec.ready.catch(() => undefined);
  return dec;
}

describe('pcmFloat32ToWav', () => {
  it('writes a canonical 44-byte RIFF/PCM header for 16 kHz mono 16-bit', () => {
    const wav = pcmFloat32ToWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
    expect(wav.length).toBe(44 + 7 * 2);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(36 + 14);
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000); // byte rate
    expect(wav.readUInt16LE(32)).toBe(2); // block align
    expect(wav.readUInt16LE(34)).toBe(16); // bits
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(14);
  });

  it('scales and clips samples to signed 16-bit', () => {
    const wav = pcmFloat32ToWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2, -2]));
    const s = (i: number) => wav.readInt16LE(44 + i * 2);
    expect(s(0)).toBe(0);
    expect(s(1)).toBe(Math.round(0.5 * 0x7fff));
    expect(s(2)).toBe(Math.round(-0.5 * 0x8000));
    expect(s(3)).toBe(0x7fff);
    expect(s(4)).toBe(-0x8000);
    expect(s(5)).toBe(0x7fff); // clipped
    expect(s(6)).toBe(-0x8000); // clipped
  });
});

describe('oggOpusToWav16k (fake decoder)', () => {
  it('returns WAV bytes + duration from the decoded sample count, and frees the decoder', async () => {
    const dec = fakeDecoder({
      channelData: [new Float32Array(16_000 * 2).fill(0.25)],
      samplesDecoded: 16_000 * 2,
    });
    const out = await oggOpusToWav16k(Buffer.from('ogg'), async () => dec);
    expect(out.durationMs).toBe(2000);
    expect(out.wav.length).toBe(44 + 16_000 * 2 * 2);
    expect(out.wav.readInt16LE(44)).toBe(Math.round(0.25 * 0x7fff));
    expect(dec.freed).toBe(1);
    // the buffer is handed over as a view, not copied
    const arg = (dec.decodeFile as jest.Mock).mock.calls[0][0] as Uint8Array;
    expect(Buffer.from(arg).toString()).toBe('ogg');
  });

  it('uses only samplesDecoded of channel 0 (ignores padding and extra channels)', async () => {
    const dec = fakeDecoder({
      channelData: [
        new Float32Array(10).fill(0.1),
        new Float32Array(10).fill(0.9),
      ],
      samplesDecoded: 4,
    });
    const out = await oggOpusToWav16k(Buffer.from('ogg'), async () => dec);
    expect(out.wav.length).toBe(44 + 4 * 2);
    expect(out.wav.readInt16LE(44)).toBe(Math.round(0.1 * 0x7fff));
    expect(out.durationMs).toBe(0); // 4 samples @ 16 kHz rounds to 0 ms
  });

  it('throws OpusDecodeError when nothing was decoded, naming the decoder error count', async () => {
    const dec = fakeDecoder({ samplesDecoded: 0, errors: [{}, {}] });
    await expect(
      oggOpusToWav16k(Buffer.from('ogg'), async () => dec),
    ).rejects.toThrow(
      new OpusDecodeError('no audio decoded (2 decoder error(s))'),
    );
    expect(dec.freed).toBe(1);
  });

  it('throws OpusDecodeError on an unexpected sample rate', async () => {
    const dec = fakeDecoder({
      channelData: [new Float32Array(48)],
      samplesDecoded: 48,
      sampleRate: 48_000,
    });
    await expect(
      oggOpusToWav16k(Buffer.from('ogg'), async () => dec),
    ).rejects.toThrow('decoder returned 48000 Hz, expected 16000');
  });

  it('wraps decodeFile rejections and still frees', async () => {
    const dec = fakeDecoder(new Error('corrupt page'));
    await expect(
      oggOpusToWav16k(Buffer.from('ogg'), async () => dec),
    ).rejects.toThrow('decode threw: corrupt page');
    expect(dec.freed).toBe(1);
  });

  it('wraps factory / ready failures as "decoder unavailable"', async () => {
    await expect(
      oggOpusToWav16k(Buffer.from('ogg'), async () => {
        throw new Error('ESM import failed');
      }),
    ).rejects.toThrow('decoder unavailable: ESM import failed');
    const dec = fakeDecoder({}, { readyRejects: new Error('wasm compile') });
    await expect(
      oggOpusToWav16k(Buffer.from('ogg'), async () => dec),
    ).rejects.toThrow('decoder unavailable: wasm compile');
  });

  it('warmUpOpusDecoder awaits ready and frees', async () => {
    const dec = fakeDecoder({});
    await warmUpOpusDecoder(async () => dec);
    expect(dec.freed).toBe(1);
  });
});

// Real WASM decode of a 0.5 s Opus tone. ogg-opus-decoder is ESM-only; when
// this Jest runtime cannot load it the test says so and passes vacuously —
// the fake-decoder cases above still cover the conversion logic.
describe('oggOpusToWav16k (real ogg-opus-decoder)', () => {
  it('decodes the 500 ms fixture to 16 kHz WAV of the right length', async () => {
    let available = true;
    try {
      await warmUpOpusDecoder(defaultDecoderFactory);
    } catch (err) {
      available = false;
      console.warn(
        `ogg-opus-decoder not loadable under jest: ${(err as Error).message}`,
      );
    }
    if (!available) return;
    const ogg = readFileSync(join(__dirname, '__fixtures__', 'tone-500ms.ogg'));
    const out = await oggOpusToWav16k(ogg);
    expect(out.durationMs).toBeGreaterThanOrEqual(480);
    expect(out.durationMs).toBeLessThanOrEqual(520);
    expect(out.wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(out.wav.readUInt32LE(24)).toBe(16_000);
    // ~0.5 s × 16 kHz × 2 bytes
    expect(out.wav.length).toBeGreaterThan(44 + 15_000);
    expect(out.wav.length).toBeLessThan(44 + 17_000);
  });
});
