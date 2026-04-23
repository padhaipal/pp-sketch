import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import {
  MediaMetadataCoverageResponse,
  MediaMetadataCoverageRow,
} from './media-meta-data.dto';

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
      active: string;
    }> = await this.dataSource.query(
      `SELECT state_transition_id, COUNT(*) AS active
       FROM media_metadata
       WHERE media_type = 'audio'
         AND NOT rolled_back
         AND state_transition_id IS NOT NULL
         AND position('-' in state_transition_id) > 0
       GROUP BY state_transition_id`,
    );

    const byPrefix = new Map<string, Map<string, number>>();
    for (const row of aggregateRows) {
      const stid = row.state_transition_id;
      const dashIdx = stid.indexOf('-');
      const prefix = stid.substring(0, dashIdx);
      const suffix = stid.substring(dashIdx + 1);
      let counts = byPrefix.get(prefix);
      if (!counts) {
        counts = new Map();
        byPrefix.set(prefix, counts);
      }
      counts.set(suffix, (counts.get(suffix) ?? 0) + Number(row.active));
    }

    const letterRows: Array<{ grapheme: string }> = await this.dataSource.query(
      `SELECT grapheme FROM letters ORDER BY created_at`,
    );
    const letters = letterRows.map((r) => r.grapheme);

    const orderedPrefixes: string[] = ['_', ...letters, ...this.wordList];

    const rows: MediaMetadataCoverageRow[] = orderedPrefixes.map((prefix) => {
      const counts = byPrefix.get(prefix);
      return {
        prefix,
        counts: SUFFIXES.map((s) => counts?.get(s) ?? 0),
      };
    });

    return { suffixes: [...SUFFIXES], rows };
  }
}