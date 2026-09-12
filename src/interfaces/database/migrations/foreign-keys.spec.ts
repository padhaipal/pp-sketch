import * as fs from 'fs';
import * as path from 'path';

// Every FK onto users or media_metadata must cascade on delete so
// `DELETE FROM users` is the whole per-user delete (UserService.delete) —
// except the content-side references below, which must NOT cascade (a
// content purge must never silently erase lesson history or letters).
//
// Pure file parsing over the migration sources, in timestamp order: each
// constraint is tracked by name, the LAST definition wins, a DROP
// CONSTRAINT clears it, an absent ON DELETE clause means NO ACTION. Only
// up() bodies are read — down() re-creates the old NO ACTION shape.
const ALLOWED_NO_ACTION = new Set([
  'users.referrer_user_id',
  'outbound_messages.media_metadata_id',
  'literacy_lesson_states.passage_id',
  'letters.media_metadata_id',
]);
const GUARDED_TARGETS = new Set(['users', 'media_metadata']);

interface ForeignKey {
  table: string;
  column: string;
  references: string;
  onDelete: string;
}

function upBody(source: string): string {
  const start = source.indexOf('async up(');
  if (start < 0) return '';
  const end = source.indexOf('async down(', start);
  return source.slice(start, end < 0 ? undefined : end);
}

function applyMigrationSource(
  source: string,
  constraints: Map<string, ForeignKey>,
): void {
  // Collapse whitespace so multi-line clauses parse as one statement.
  const sql = upBody(source).replace(/\s+/g, ' ');

  // Statement-ish chunks: split on `;` and on the backtick that ends a
  // template literal, so one queryRunner.query(...) is one chunk.
  for (const chunk of sql.split(/;|`/)) {
    const drop = /DROP CONSTRAINT (?:IF EXISTS )?"([^"]+)"/i.exec(chunk);
    if (drop) constraints.delete(drop[1]);

    const fkRe =
      /(?:ALTER TABLE "([^"]+)" ADD )?CONSTRAINT "([^"]+)" FOREIGN KEY \("([^"]+)"\) REFERENCES "([^"]+)"\s*\("[^"]+"\)((?: ON (?:DELETE|UPDATE) (?:CASCADE|NO ACTION|SET NULL|RESTRICT|SET DEFAULT))*)/gi;
    for (const m of chunk.matchAll(fkRe)) {
      const [, alterTable, name, column, references, actions] = m;
      const table =
        alterTable ?? /CREATE TABLE "([^"]+)"/i.exec(chunk)?.[1] ?? '?';
      const onDelete =
        /ON DELETE (CASCADE|NO ACTION|SET NULL|RESTRICT|SET DEFAULT)/i.exec(
          actions ?? '',
        )?.[1] ?? 'NO ACTION';
      constraints.set(name, {
        table,
        column,
        references,
        onDelete: onDelete.toUpperCase(),
      });
    }
  }
}

function loadForeignKeys(): Map<string, ForeignKey> {
  const dir = __dirname;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+-.*\.ts$/.test(f))
    .sort();
  const constraints = new Map<string, ForeignKey>();
  for (const file of files) {
    applyMigrationSource(
      fs.readFileSync(path.join(dir, file), 'utf-8'),
      constraints,
    );
  }
  return constraints;
}

describe('migrations — foreign keys onto users / media_metadata', () => {
  const constraints = loadForeignKeys();
  const guarded = [...constraints.values()].filter((fk) =>
    GUARDED_TARGETS.has(fk.references),
  );

  it('parses the expected set of guarded foreign keys', () => {
    const columns = guarded.map((fk) => `${fk.table}.${fk.column}`).sort();
    expect(columns).toEqual(
      [
        'letters.media_metadata_id',
        'literacy_lesson_states.passage_id',
        'literacy_lesson_states.user_id',
        'literacy_lesson_states.user_message_id',
        'media_metadata.input_media_id',
        'media_metadata.user_id',
        'onboarding_states.user_id',
        'onboarding_states.user_message_id',
        'outbound_messages.media_metadata_id',
        'outbound_messages.user_id',
        'outbound_messages.user_message_id',
        'scores.user_id',
        'scores.user_message_id',
        'test_results_student.student_id',
        'users.referrer_user_id',
      ].sort(),
    );
  });

  it('every surviving FK onto users or media_metadata cascades, except the allow-list', () => {
    const wrong = guarded
      .filter((fk) => {
        const key = `${fk.table}.${fk.column}`;
        return ALLOWED_NO_ACTION.has(key)
          ? fk.onDelete !== 'NO ACTION'
          : fk.onDelete !== 'CASCADE';
      })
      .map((fk) => `${fk.table}.${fk.column} → ${fk.onDelete}`);
    expect(wrong).toEqual([]);
  });

  // Not a guarded target (geo_entity), so the cascade rule above never sees
  // it — but deleting a school must not delete its teacher.
  it('users.geo_entity_id → geo_entity is ON DELETE SET NULL', () => {
    const fk = [...constraints.values()].find(
      (c) => c.table === 'users' && c.column === 'geo_entity_id',
    );
    expect(fk).toEqual(
      expect.objectContaining({
        references: 'geo_entity',
        onDelete: 'SET NULL',
      }),
    );
  });

  it.each([
    ['test_results_student', 'geo_entity_id', 'SET NULL'],
    ['test_results_geo_entity', 'geo_entity_id', 'CASCADE'],
  ])('%s.%s → geo_entity is ON DELETE %s', (table, column, onDelete) => {
    const fk = [...constraints.values()].find(
      (c) => c.table === table && c.column === column,
    );
    expect(fk).toEqual(
      expect.objectContaining({ references: 'geo_entity', onDelete }),
    );
  });

  it('the allow-list only names FKs that exist', () => {
    const existing = new Set(guarded.map((fk) => `${fk.table}.${fk.column}`));
    for (const key of ALLOWED_NO_ACTION) {
      expect(existing.has(key)).toBe(true);
    }
  });
});
