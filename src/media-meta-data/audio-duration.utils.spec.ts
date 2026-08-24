import { oggOpusDurationMs } from './audio-duration.utils';

// Fixtures are synthesized, not sampled: an Ogg page is 27 header bytes +
// segment table + payload, and only the fields the parser reads (magic,
// version at +4, granule int64 LE at +6, segment count at +26) need to be
// real. Payload sizes stay < 255 so one lacing value per segment suffices.
function oggPage(opts: {
  granule: bigint;
  version?: number;
  segments?: Buffer[];
}): Buffer {
  const segments = opts.segments ?? [];
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header[4] = opts.version ?? 0;
  header.writeBigInt64LE(opts.granule, 6);
  header[26] = segments.length;
  const lacing = Buffer.from(segments.map((s) => s.length));
  return Buffer.concat([header, lacing, ...segments]);
}

// Minimal 19-byte OpusHead packet; pre_skip is the uint16 LE at +10.
function opusHead(preSkip: number): Buffer {
  const b = Buffer.alloc(19);
  b.write('OpusHead', 0, 'ascii');
  b[8] = 1; // version
  b[9] = 1; // channels
  b.writeUInt16LE(preSkip, 10);
  b.writeUInt32LE(48_000, 12);
  return b;
}

const PRE_SKIP = 312;

function headPage(preSkip = PRE_SKIP): Buffer {
  return oggPage({ granule: 0n, segments: [opusHead(preSkip)] });
}

describe('oggOpusDurationMs', () => {
  it('single page: granule on the OpusHead page itself yields the duration', async () => {
    // Contrived but valid for the parser: the head page doubles as the last
    // page. 47 bytes exactly — also pins the minimum-size boundary.
    const buf = oggPage({
      granule: BigInt(PRE_SKIP) + 96_000n,
      segments: [opusHead(PRE_SKIP)],
    });
    expect(buf.length).toBe(47);
    expect(oggOpusDurationMs(buf)).toBe(2000);
  });

  it('multi-page: the LAST page granule wins and pre_skip is subtracted', async () => {
    const buf = Buffer.concat([
      headPage(),
      oggPage({
        granule: BigInt(PRE_SKIP) + 24_000n,
        segments: [Buffer.alloc(10)],
      }),
      oggPage({
        granule: BigInt(PRE_SKIP) + 48_000n,
        segments: [Buffer.alloc(10)],
      }),
    ]);
    expect(oggOpusDurationMs(buf)).toBe(1000);
  });

  it('floors sub-millisecond remainders (integer ms)', async () => {
    const buf = Buffer.concat([
      headPage(),
      oggPage({
        granule: BigInt(PRE_SKIP) + 48_001n,
        segments: [Buffer.alloc(4)],
      }),
    ]);
    expect(oggOpusDurationMs(buf)).toBe(1000);
  });

  it('skips a trailing granule -1 page (packet spans pages, no timestamp)', async () => {
    const buf = Buffer.concat([
      headPage(),
      oggPage({
        granule: BigInt(PRE_SKIP) + 48_000n,
        segments: [Buffer.alloc(8)],
      }),
      oggPage({ granule: -1n, segments: [Buffer.alloc(8)] }),
    ]);
    expect(oggOpusDurationMs(buf)).toBe(1000);
  });

  it('does not trust a raw OggS inside packet data (version byte != 0)', async () => {
    // Payload deliberately embeds 'OggS' + junk that decodes to a huge
    // granule; the real last page says 1000ms, and the fake must lose.
    const fakePayload = Buffer.concat([
      Buffer.from('OggS'),
      Buffer.from([7]), // "version" — not 0, so not a page
      Buffer.alloc(20, 0xff),
    ]);
    const buf = Buffer.concat([
      headPage(),
      oggPage({
        granule: BigInt(PRE_SKIP) + 48_000n,
        segments: [fakePayload],
      }),
    ]);
    expect(oggOpusDurationMs(buf)).toBe(1000);
  });

  it('skips an OggS candidate too close to the end for a full header', async () => {
    const buf = Buffer.concat([
      headPage(),
      oggPage({
        granule: BigInt(PRE_SKIP) + 48_000n,
        segments: [Buffer.alloc(4)],
      }),
      Buffer.from('OggS'), // truncated trailing candidate
    ]);
    expect(oggOpusDurationMs(buf)).toBe(1000);
  });

  it('returns null for buffers under 47 bytes', async () => {
    expect(oggOpusDurationMs(Buffer.alloc(46))).toBeNull();
  });

  it('returns null when OpusHead is missing', async () => {
    const buf = oggPage({ granule: 48_000n, segments: [Buffer.alloc(19)] });
    expect(oggOpusDurationMs(buf)).toBeNull();
  });

  it('returns null when OpusHead sits too close to the end to carry pre_skip', async () => {
    const buf = Buffer.concat([
      Buffer.alloc(40, 1),
      Buffer.from('OpusHead'), // +12 bytes would run past the end
    ]);
    expect(oggOpusDurationMs(buf)).toBeNull();
  });

  it('returns null when no OggS page exists at all', async () => {
    const buf = Buffer.concat([Buffer.alloc(30, 1), opusHead(PRE_SKIP)]);
    expect(oggOpusDurationMs(buf)).toBeNull();
  });

  it('returns null when every OggS candidate fails validation (loop exhausts)', async () => {
    // Single candidate at offset 0 with a non-zero version byte; OpusHead
    // present so the scan itself is reached, then falls off the front.
    const bad = oggPage({
      granule: 48_000n,
      version: 9,
      segments: [opusHead(PRE_SKIP)],
    });
    expect(oggOpusDurationMs(bad)).toBeNull();
  });

  it('returns null when the last granule is at or below pre_skip', async () => {
    const atPreSkip = Buffer.concat([
      headPage(1000),
      oggPage({ granule: 1000n, segments: [Buffer.alloc(4)] }),
    ]);
    expect(oggOpusDurationMs(atPreSkip)).toBeNull();
    const below = Buffer.concat([
      headPage(1000),
      oggPage({ granule: 500n, segments: [Buffer.alloc(4)] }),
    ]);
    expect(oggOpusDurationMs(below)).toBeNull();
  });
});
