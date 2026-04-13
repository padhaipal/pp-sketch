// pp-sketch/src/literacy/letters/letter.service.prompt.md
// Called exclusively by the admin dashboard via letter.controller.ts.
// No caching — letters are static content managed infrequently by admins.
//
// ## DB access pattern
// Uses TypeORM Repository API (`@InjectRepository(LetterEntity)`) for all CRUD.
// No raw SQL — all queries are simple single-table operations.

create(options: CreateLetterOptions): Promise<Letter>
* Validate options with validateCreateLetterOptions(). If fails, log WARN and let BadRequestException propagate.
* Single INSERT: INSERT INTO letters (id, grapheme, media_metadata_id) VALUES (uuid(), $1, $2) RETURNING *
* If DB throws a unique constraint violation on grapheme: throw BadRequestException('create() grapheme already exists').
* Return the created entity.

createBulk(options: CreateBulkLetterOptions): Promise<Letter[]>
* Validate options with validateCreateBulkLetterOptions(). If fails, log WARN and let BadRequestException propagate.
* Single bulk INSERT: INSERT INTO letters (id, grapheme, media_metadata_id) VALUES (...) RETURNING *
* If DB throws a unique constraint violation: throw BadRequestException('createBulk() one or more graphemes already exist').
  Note: the insert runs as a single query — the first conflicting grapheme causes the entire batch to fail with no partial inserts.
* Return the created entities.

update(options: UpdateLetterOptions): Promise<Letter | null>
* Validate options with validateUpdateLetterOptions(). If fails, log WARN and let BadRequestException propagate.
* Single UPDATE WHERE grapheme = options.grapheme, setting only the fields present in options (new_grapheme, new_media_metadata_id).
* If no row was updated: return null (letter not found).
* If DB throws a unique constraint violation on new_grapheme: throw BadRequestException('update() new_grapheme already exists').
* Return the updated entity.

delete(options: DeleteLetterOptions): Promise<boolean>
* Validate options with validateDeleteLetterOptions(). If fails, log WARN and let BadRequestException propagate.
* DELETE FROM letters WHERE grapheme = $1 RETURNING id.
* If DB throws a foreign key constraint violation: throw BadRequestException('delete() letter is referenced by existing scores — remove scores first').
* Return true if a row was deleted, false if not found.
