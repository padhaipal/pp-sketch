import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import {
  MediaMetadataCoverageResponse,
  MediaMetadataCoverageRow,
  MediaType,
  MediaTypeCounts,
  VALID_MEDIA_TYPES,
} from './media-meta-data.dto';

function emptyCounts(): MediaTypeCounts {
  return {
    audio: 0,
    text: 0,
    video: 0,
    image: 0,
    sticker: 0,
  };
}

// Derived from state_transition_id templates in literacy-lesson.machine.ts.
// Ordered alphabetically for stable column layout.
const SUFFIXES = [
  'image-image-wrong-first',
  'image-letterImage-correct',
  'image-letterImage-maxErrors',
  'letter-image-wrong',
  'letter-routeWrongLetter-correct-more',
  'letter-word-correct-last',
  'letterImage-letterImage-wrong-first',
  'letterImage-letterImage-wrong-second',
  'letterImage-routeWrongLetter-correct-more',
  'letterImage-routeWrongLetter-maxErrors-more',
  'letterImage-word-correct-last',
  'letterImage-word-maxErrors-last',
  'letterNoImage-letterNoImage-wrong-first',
  'letterNoImage-routeWrongLetter-correct-first-more',
  'letterNoImage-routeWrongLetter-correct-retry-more',
  'letterNoImage-routeWrongLetter-wrong-more',
  'letterNoImage-word-correct-first-last',
  'letterNoImage-word-correct-retry-last',
  'letterNoImage-word-wrong-last',
  'start-word-initial',
  'word-complete-correct-first',
  'word-complete-correct-retry',
  'word-complete-maxErrors',
  'word-routeWrongLetter-drillLetters',
  'word-word-endMatra-first',
  'word-word-endMatra-retry',
  'word-word-insertion-first',
  'word-word-insertion-retry',
  'word-word-loopBack',
  'word-word-middleMatra-first',
  'word-word-middleMatra-retry',
] as const;

@Injectable()
export class MediaMetadataCoverageService {
  private readonly wordList: string[];

  constructor(private readonly dataSource: DataSource) {
    const wordListPath = path.join(
      __dirname,
      '..',
      'literacy',
      'literacy-lesson',
      'word-list.json',
    );
    this.wordList = JSON.parse(fs.readFileSync(wordListPath, 'utf-8'));
  }

  async getCoverage(): Promise<MediaMetadataCoverageResponse> {
    const aggregateRows: Array<{
      state_transition_id: string;
      media_type: MediaType;
      active: string;
    }> = await this.dataSource.query(
      `SELECT state_transition_id, media_type, COUNT(*) AS active
       FROM media_metadata
       WHERE NOT rolled_back
         AND state_transition_id IS NOT NULL
         AND position('-' in state_transition_id) > 0
       GROUP BY state_transition_id, media_type`,
    );

    const byPrefix = new Map<string, Map<string, MediaTypeCounts>>();
    for (const row of aggregateRows) {
      const stid = row.state_transition_id;
      const dashIdx = stid.indexOf('-');
      const prefix = stid.substring(0, dashIdx);
      const suffix = stid.substring(dashIdx + 1);
      let bySuffix = byPrefix.get(prefix);
      if (!bySuffix) {
        bySuffix = new Map();
        byPrefix.set(prefix, bySuffix);
      }
      let counts = bySuffix.get(suffix);
      if (!counts) {
        counts = emptyCounts();
        bySuffix.set(suffix, counts);
      }
      // media_type values that aren't in VALID_MEDIA_TYPES are ignored.
      if (row.media_type in counts) {
        counts[row.media_type] += Number(row.active);
      }
    }

    const letterRows: Array<{ grapheme: string }> = await this.dataSource.query(
      `SELECT grapheme FROM letters ORDER BY created_at`,
    );
    const letters = letterRows.map((r) => r.grapheme);

    const orderedPrefixes: string[] = ['_', ...letters, ...this.wordList];

    const rows: MediaMetadataCoverageRow[] = orderedPrefixes.map((prefix) => {
      const bySuffix = byPrefix.get(prefix);
      return {
        prefix,
        counts: SUFFIXES.map((s) => bySuffix?.get(s) ?? emptyCounts()),
      };
    });

    return {
      suffixes: [...SUFFIXES],
      media_types: [...VALID_MEDIA_TYPES],
      rows,
      letters,
      words: this.wordList,
    };
  }
}