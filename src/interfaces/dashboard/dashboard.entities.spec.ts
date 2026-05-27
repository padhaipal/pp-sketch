// The dashboard service uses raw SQL, so its entity classes are never
// imported by production code in this directory. They still need their
// TypeORM decorators to execute (so migrations + cross-module references
// work). Touching them here lets Jest count their decorator statements.

import { getMetadataArgsStorage } from 'typeorm';
import { QuizResponseEntity } from './quiz-response.entity';
import { MailingListEntryEntity } from './mailing-list-entry.entity';
import { QuizShareTokenEntity } from './quiz-share-token.entity';

describe('dashboard entities — TypeORM metadata is registered at import time', () => {
  it('QuizResponseEntity is registered with the expected table name', () => {
    const tables = getMetadataArgsStorage().tables;
    expect(tables.some((t) => t.target === QuizResponseEntity)).toBe(true);
    const t = tables.find((t) => t.target === QuizResponseEntity);
    expect(t?.name).toBe('quiz_responses');
  });

  it('MailingListEntryEntity is registered', () => {
    const tables = getMetadataArgsStorage().tables;
    expect(tables.some((t) => t.target === MailingListEntryEntity)).toBe(true);
  });

  it('QuizShareTokenEntity is registered', () => {
    const tables = getMetadataArgsStorage().tables;
    expect(tables.some((t) => t.target === QuizShareTokenEntity)).toBe(true);
  });

  it('an instance can be allocated (covers property field declarations)', () => {
    expect(new QuizResponseEntity()).toBeInstanceOf(QuizResponseEntity);
    expect(new MailingListEntryEntity()).toBeInstanceOf(MailingListEntryEntity);
    expect(new QuizShareTokenEntity()).toBeInstanceOf(QuizShareTokenEntity);
  });
});
