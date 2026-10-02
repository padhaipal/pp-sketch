/**
 * Ogg/Opus → 16 kHz mono 16-bit WAV, for the Bodhan STT branch only.
 *
 * Why: Bodhan's upstream ASR vendor rejects Ogg/Opus (and MP3) with a 502
 * after 5–6 s — verified 2026-10-02 with the staging key — while a 16 kHz
 * mono WAV of the same recording transcribes in ~1.5 s. WhatsApp voice notes
 * are always Ogg/Opus, so this branch decodes before uploading. Sarvam,
 * Azure and Reverie keep receiving the raw bytes; nothing here runs on
 * their path.
 *
 * Decoder: `ogg-opus-decoder` (WASM, no native build). It is ESM-only and
 * pp-sketch compiles to CommonJS, so it is loaded with a dynamic import()
 * (TypeScript under `module: nodenext` emits a real import(), which Node 22
 * resolves to the ESM package). The decoder resamples to 16 kHz itself
 * (`sampleRate` option — supported at runtime, absent from its types).
 * One decoder per call: construction is ~0 ms once the WASM has compiled,
 * and it keeps concurrent voice notes from sharing decoder state.
 */

export const WAV_SAMPLE_RATE = 16_000;
const WAV_CHANNELS = 1;
const WAV_BITS = 16;
const WAV_HEADER_BYTES = 44;

export interface DecodedPcm {
  channelData: Float32Array[];
  samplesDecoded: number;
  sampleRate: number;
  errors: unknown[];
}

/** The slice of OggOpusDecoder this module uses — injectable for tests. */
export interface OpusDecoderLike {
  ready: Promise<void>;
  decodeFile: (data: Uint8Array) => Promise<DecodedPcm>;
  free: () => void;
}

export type OpusDecoderFactory = () => Promise<OpusDecoderLike>;

export class OpusDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpusDecodeError';
  }
}

let decoderModule: Promise<{
  OggOpusDecoder: new (opts: { sampleRate: number }) => OpusDecoderLike;
}> | null = null;

/** Loads (once) and caches the ESM decoder module; retried if it rejected. */
function loadDecoderModule() {
  if (!decoderModule) {
    decoderModule = (
      import('ogg-opus-decoder') as Promise<{
        OggOpusDecoder: new (opts: { sampleRate: number }) => OpusDecoderLike;
      }>
    ).catch((err: unknown) => {
      decoderModule = null;
      throw err;
    });
  }
  return decoderModule;
}

export const defaultDecoderFactory: OpusDecoderFactory = async () => {
  const { OggOpusDecoder } = await loadDecoderModule();
  return new OggOpusDecoder({ sampleRate: WAV_SAMPLE_RATE });
};

/**
 * Compiles the WASM once so the first voice note after boot doesn't pay for
 * it. Errors are swallowed (logged by the caller); the first real call will
 * retry the import.
 */
export async function warmUpOpusDecoder(
  factory: OpusDecoderFactory = defaultDecoderFactory,
): Promise<void> {
  const decoder = await factory();
  await decoder.ready;
  decoder.free();
}

export interface WavResult {
  wav: Buffer;
  /** Audible length derived from the decoded sample count. */
  durationMs: number;
}

export async function oggOpusToWav16k(
  oggOpus: Buffer,
  factory: OpusDecoderFactory = defaultDecoderFactory,
): Promise<WavResult> {
  let decoder: OpusDecoderLike;
  try {
    decoder = await factory();
    await decoder.ready;
  } catch (err) {
    throw new OpusDecodeError(`decoder unavailable: ${(err as Error).message}`);
  }
  let decoded: DecodedPcm;
  try {
    decoded = await decoder.decodeFile(
      new Uint8Array(oggOpus.buffer, oggOpus.byteOffset, oggOpus.byteLength),
    );
  } catch (err) {
    throw new OpusDecodeError(`decode threw: ${(err as Error).message}`);
  } finally {
    decoder.free();
  }
  if (decoded.samplesDecoded <= 0 || decoded.channelData.length === 0) {
    throw new OpusDecodeError(
      `no audio decoded (${decoded.errors.length} decoder error(s))`,
    );
  }
  if (decoded.sampleRate !== WAV_SAMPLE_RATE) {
    throw new OpusDecodeError(
      `decoder returned ${decoded.sampleRate} Hz, expected ${WAV_SAMPLE_RATE}`,
    );
  }
  // Voice notes are mono; if a stereo file ever arrives, channel 0 is enough
  // for speech recognition.
  const pcm = decoded.channelData[0].subarray(0, decoded.samplesDecoded);
  return {
    wav: pcmFloat32ToWav(pcm),
    durationMs: Math.round((decoded.samplesDecoded / WAV_SAMPLE_RATE) * 1000),
  };
}

/** Float32 [-1, 1] → 16-bit little-endian PCM with a canonical RIFF header. */
export function pcmFloat32ToWav(samples: Float32Array): Buffer {
  const dataBytes = samples.length * (WAV_BITS / 8);
  const wav = Buffer.alloc(WAV_HEADER_BYTES + dataBytes);
  const byteRate = WAV_SAMPLE_RATE * WAV_CHANNELS * (WAV_BITS / 8);
  const blockAlign = WAV_CHANNELS * (WAV_BITS / 8);

  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // PCM fmt chunk size
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(WAV_CHANNELS, 22);
  wav.writeUInt32LE(WAV_SAMPLE_RATE, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(WAV_BITS, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(
      s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff),
      offset,
    );
    offset += 2;
  }
  return wav;
}
