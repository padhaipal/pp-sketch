// Real-decoder smoke test for the Bodhan STT branch. Jest (CommonJS) cannot
// load the ESM-only `ogg-opus-decoder`, so the WASM path is exercised here
// against the COMPILED CommonJS module (dist/…/opus-to-wav.js) — the same
// dynamic import() the production process performs. Run after `npm run build`:
//   npm run test:opus
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  oggOpusToWav16k,
  warmUpOpusDecoder,
} = require('../dist/interfaces/stt/bodhan/opus-to-wav.js');

const fixture = new URL(
  '../src/interfaces/stt/bodhan/__fixtures__/tone-500ms.ogg',
  import.meta.url,
);

const t0 = performance.now();
await warmUpOpusDecoder();
const t1 = performance.now();
const { wav, durationMs } = await oggOpusToWav16k(readFileSync(fixture));
const t2 = performance.now();

const checks = [
  ['RIFF header', wav.toString('ascii', 0, 4) === 'RIFF'],
  ['16 kHz', wav.readUInt32LE(24) === 16000],
  ['mono', wav.readUInt16LE(22) === 1],
  ['16-bit', wav.readUInt16LE(34) === 16],
  ['duration 480–520 ms', durationMs >= 480 && durationMs <= 520],
  ['data length matches', wav.readUInt32LE(40) === wav.length - 44],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
  ok &&= pass;
}
console.log(
  `warm-up ${Math.round(t1 - t0)} ms, decode ${Math.round(t2 - t1)} ms, ${wav.length} B WAV, ${durationMs} ms audio`,
);
if (!ok) process.exit(1);
