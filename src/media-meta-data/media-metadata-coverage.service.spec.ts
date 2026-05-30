// Stub the word-list JSON read so the service doesn't depend on file layout.
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: jest.fn(() => JSON.stringify(['word1', 'word2'])),
  };
});

import type { DataSource } from 'typeorm';
import { MediaMetadataCoverageService } from './media-metadata-coverage.service';

function makeDataSource(query: jest.Mock): DataSource {
  return { query } as unknown as DataSource;
}

describe('MediaMetadataCoverageService.getCoverage', () => {
  it('groups counts by prefix/suffix and assembles ordered rows (`_` then letters then words)', async () => {
    const aggregateRows = [
      // letter prefix 'क'
      {
        state_transition_id: 'क-letter-word-correct-last',
        media_type: 'audio',
        active: '3',
      },
      {
        state_transition_id: 'क-letter-word-correct-last',
        media_type: 'video',
        active: 2,
      },
      // generic prefix '_'
      {
        state_transition_id: '_-image-image-wrong-first',
        media_type: 'image',
        active: '1',
      },
      // word prefix 'word1' — suffix is one of the WHOLE entries in SUFFIXES
      {
        state_transition_id: 'word1-word-word-loopBack',
        media_type: 'text',
        active: '5',
      },
      // word-word-loopBack maps to a SUFFIX entry "word-word-loopBack"
      // invalid media_type → ignored
      {
        state_transition_id: 'क-letter-word-correct-last',
        media_type: 'BAD',
        active: '99',
      },
    ];
    const letterRows = [{ grapheme: 'क' }, { grapheme: 'ख' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce(aggregateRows) // aggregate
      .mockResolvedValueOnce(letterRows); // letters
    const svc = new MediaMetadataCoverageService(makeDataSource(query));

    const out = await svc.getCoverage();

    // Static suffix list is in the implementation; verify a couple of known entries.
    expect(out.suffixes).toContain('letter-word-correct-last');
    expect(out.suffixes).toContain('image-image-wrong-first');
    expect(out.media_types).toEqual([
      'audio',
      'text',
      'video',
      'image',
      'sticker',
    ]);
    expect(out.letters).toEqual(['क', 'ख']);
    expect(out.words).toEqual(['word1', 'word2']);
    // Row ordering: '_', then letters, then words.
    expect(out.rows.map((r) => r.prefix)).toEqual([
      '_',
      'क',
      'ख',
      'word1',
      'word2',
    ]);
  });

  it('produces the expected counts in the matching suffix column and zeroes elsewhere', async () => {
    const aggregateRows = [
      {
        state_transition_id: 'क-letter-word-correct-last',
        media_type: 'audio',
        active: '3',
      },
      {
        state_transition_id: 'क-letter-word-correct-last',
        media_type: 'video',
        active: 2,
      },
    ];
    const letterRows = [{ grapheme: 'क' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce(aggregateRows)
      .mockResolvedValueOnce(letterRows);
    const svc = new MediaMetadataCoverageService(makeDataSource(query));

    const out = await svc.getCoverage();

    const kRow = out.rows.find((r) => r.prefix === 'क')!;
    const suffixIdx = out.suffixes.indexOf('letter-word-correct-last');
    expect(kRow.counts[suffixIdx]).toEqual({
      audio: 3,
      text: 0,
      video: 2,
      image: 0,
      sticker: 0,
    });
    // Any unrelated suffix should be all zeros.
    const otherIdx = out.suffixes.indexOf('word-word-loopBack');
    expect(kRow.counts[otherIdx]).toEqual({
      audio: 0,
      text: 0,
      video: 0,
      image: 0,
      sticker: 0,
    });
  });

  it('emits empty-count rows for every prefix when the aggregate query returns no rows', async () => {
    const letterRows = [{ grapheme: 'क' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(letterRows);
    const svc = new MediaMetadataCoverageService(makeDataSource(query));

    const out = await svc.getCoverage();

    // 1 generic + 1 letter + 2 words = 4
    expect(out.rows).toHaveLength(4);
    for (const row of out.rows) {
      for (const counts of row.counts) {
        expect(counts).toEqual({
          audio: 0,
          text: 0,
          video: 0,
          image: 0,
          sticker: 0,
        });
      }
    }
  });

  it('drops aggregate rows whose media_type is not in VALID_MEDIA_TYPES', async () => {
    const aggregateRows = [
      // 'tiktok' is not a valid type — must be ignored.
      {
        state_transition_id: 'क-letter-word-correct-last',
        media_type: 'tiktok',
        active: '99',
      },
    ];
    const letterRows = [{ grapheme: 'क' }];
    const query = jest
      .fn()
      .mockResolvedValueOnce(aggregateRows)
      .mockResolvedValueOnce(letterRows);
    const svc = new MediaMetadataCoverageService(makeDataSource(query));

    const out = await svc.getCoverage();
    const kRow = out.rows.find((r) => r.prefix === 'क')!;
    const suffixIdx = out.suffixes.indexOf('letter-word-correct-last');
    expect(kRow.counts[suffixIdx]).toEqual({
      audio: 0,
      text: 0,
      video: 0,
      image: 0,
      sticker: 0,
    });
  });
});
