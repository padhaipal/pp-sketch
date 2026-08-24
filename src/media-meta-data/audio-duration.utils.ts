// Ogg/Opus duration without decoding: an Ogg page header stores the absolute
// granule position — for Opus, the total 48 kHz sample count up to that page,
// including the encoder's priming samples declared as pre_skip in OpusHead.
// So duration = (last_page_granule - pre_skip) / 48000, read straight off the
// container. WhatsApp voice notes are audio/ogg; codecs=opus, so this covers
// the inbound path with no new dependency and no decode.

const OGG_MAGIC = 'OggS';
const OPUS_HEAD = 'OpusHead';
// Smallest parseable container: 27-byte page header + 1 segment-table entry
// + 19-byte OpusHead packet.
const MIN_BUFFER_BYTES = 47;
// Page header layout: 'OggS' at +0, version byte at +4, granule int64 LE
// at +6..13 — so a candidate needs 14 readable bytes.
const PAGE_HEADER_MIN_BYTES = 14;
const SAMPLE_RATE = 48_000n;

export function oggOpusDurationMs(buffer: Buffer): number | null {
  if (buffer.length < MIN_BUFFER_BYTES) return null;

  const headIdx = buffer.indexOf(OPUS_HEAD);
  // pre_skip is uint16 LE at OpusHead +10.
  if (headIdx === -1 || headIdx + 12 > buffer.length) return null;
  const preSkip = BigInt(buffer.readUInt16LE(headIdx + 10));

  // Scan pages BACKWARDS: only the last page with a completed packet carries
  // the stream's total sample count. Two kinds of false candidates exist:
  // 'OggS' occurring inside packet DATA (a real page header has version
  // byte 0 at +4 — anything else is not a page), and pages whose granule is
  // -1 (no packet completes on them, so they carry no timestamp) — both are
  // skipped and the scan continues toward the front.
  let searchEnd = buffer.length - 1;
  while (searchEnd >= 0) {
    const pageIdx = buffer.lastIndexOf(OGG_MAGIC, searchEnd);
    if (pageIdx === -1) return null;
    searchEnd = pageIdx - 1;
    if (pageIdx + PAGE_HEADER_MIN_BYTES > buffer.length) continue;
    if (buffer[pageIdx + 4] !== 0) continue;
    const granule = buffer.readBigInt64LE(pageIdx + 6);
    if (granule === -1n) continue;
    // Earlier pages only have smaller granules — a last granule at or below
    // pre_skip means no audible samples, so there is nothing to salvage.
    if (granule <= preSkip) return null;
    return Number(((granule - preSkip) * 1000n) / SAMPLE_RATE);
  }
  return null;
}
