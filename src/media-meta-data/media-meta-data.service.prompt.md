// pp-sketch/src/media-meta-data/media-meta-data.service.prompt.md
See src/docs/database.md for redis/database details and fallback patterns.

Enum enforcement: MediaStatus, MediaType, and MediaSource are stored as plain text in pg (no custom pg enum types).
All writes and updates MUST call the assertion helpers (assertValidMediaStatus, assertValidMediaType, assertValidMediaSource) from media-meta-data.dto before touching the database, so that adding or removing enum values is a code-only change.

createWhatsappAudioMedia(options: CreateWhatsappAudioMediaOptions): Promise<MediaMetaData>
1.) Validate options at runtime with validateCreateWhatsappAudioMediaOptions(). If it fails, log WARN and let the BadRequestException propagate.
2.) Resolve the user (exactly one identifier was provided):
  * If options.user is provided, use its .id as user_id directly (trusted, no DB hit).
  * If options.user_external_id is provided, call user.service.ts/find() to resolve user_id. If not found, log ERROR and throw.
3.) Check if a mediaMetaData row with this wa_media_url already exists in the database.
  * If it exists and its status is 'failed', reuse that row: update its status to 'created' and continue to step 4.
  * If it exists and its status is anything other than 'failed', log WARN and return the existing entity (no-op).
  * If it does not exist, create a new mediaMetaData database row with wa_media_url = options.wa_media_url, status = 'created', rolled_back = false.
4.)
* Hit pp-sketch/src/wabot/outbound/outbound.service.ts/downloadMedia() with options.wa_media_url and get it to start streaming the audio file to this worker.
* Direct this byte flow to the following sinks. STT_TIME_CAP is a .env variable. 
  * src/media-bucket/outbound/outbound.service.ts/stream()
  * media-meta-data/stt-sarvam.service.ts/run(), media-meta-data/stt-azure.service.ts/run(), media-meta-data/stt-reverie.service.ts/run(), etc (as turned on and off by feature flags, see docs). Each run() receives the audio mediaMetaData entity and sets input_media_id on the text entity it creates.
* All of these streams will be processed in parallel asynchronously.
  * If the byte flow to the S3 bucket fails then stop all streaming immediately, make a db hit to mark this mediaMetaData entity as 'failed', log a WARN and stop this worker and mark it such that BullMQ retries it. 
  * If the byte flow to the S3 bucket succeeds but all of the speech to text ais either time out or fail then make a db hit to mark this mediaMetaData entity as 'failed', log a WARN and stop this worker and mark it such that BullMQ retries it.
  * Else: Wait until all streams are finished, error or timeout. 
    * src/media-bucket/outbound/outbound.service.ts/stream() should return the S3 bucket location for this media resource.
    * Each media-meta-data/stt-xxx.service.ts/run() will return either a mediaMetaData entity or its id.
5.) Update the audio mediaMetaData row (single row update):
* update s3_key
* update the mediaDetails field
* Update status to 'ready'
6.) Return the newly created mediaMetadata entity.

## findTranscripts(options: FindTranscriptsOptions): Promise<MediaMetaData[]>

Single DB round-trip. Returns all text transcript entities that are children of the given media entity.

1.) Validate options at runtime with `validateFindTranscriptsOptions()`. If it fails, let the BadRequestException propagate.
2.) Resolve the parent media entity's id:
  * If `options.media_metadata` is provided, use its `.id` directly (trusted, no DB hit).
  * If `options.media_metadata_id` is provided, use it directly (no DB hit — the FK relationship in the query will fail gracefully if the id doesn't exist).
  * If `options.media_metadata_wa_media_url` is provided, resolve via subquery: `(SELECT id FROM media_metadata WHERE wa_media_url = $1)`.
3.) Query: `SELECT * FROM media_metadata WHERE input_media_id = $resolvedId AND media_type = 'text' AND status = 'ready' ORDER BY created_at ASC`.
4.) Returns an empty array if no transcripts exist (caller decides whether that is an error).

## findMediaByStateTransitionId(stateTransitionId: string): Promise<FindMediaByStateTransitionIdResult>

Single DB round-trip. Looks up all ready, deliverable media entities whose `state_transition_id` matches the given `stateTransitionId`, then randomly selects one entity per media type. Uses the `(state_transition_id, status)` index.

1.) If `stateTransitionId` is not a valid non-empty string, throw BadRequestException.
2.) Query:
  ```sql
  SELECT * FROM media_metadata
  WHERE state_transition_id = $1
    AND status = 'ready'
    AND (wa_media_url IS NOT NULL OR media_type = 'text')
  ```
3.) Group the returned rows by `media_type`.
4.) For each media type (audio, video, text, image): if one or more rows exist in that group, randomly select one. If none exist for a type, that key is omitted from the result.
5.) Return the `FindMediaByStateTransitionIdResult` object.

## markRolledBack(mediaId: string): Promise<void>

Atomically tags the media_metadata row as rolled back AND deletes every row in every table that references it via a foreign key. Both operations happen inside a single transaction so the tag and the deletions are all-or-nothing.

1.) If `mediaId` is not a valid non-empty string, throw BadRequestException.
2.) Execute the following as a single database call using a plpgsql anonymous block (or a stored function):
  * `UPDATE media_metadata SET rolled_back = true WHERE id = $1`. If no row was updated (rowCount = 0), raise an exception (NotFoundException).
  * Dynamically discover all foreign key constraints that reference `media_metadata.id` by querying `pg_constraint` + `pg_attribute`:
    ```sql
    SELECT con.conrelid::regclass AS referencing_table,
           att.attname            AS referencing_column
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.confrelid = 'media_metadata'::regclass
      AND con.contype = 'f'
      AND EXISTS (
        SELECT 1 FROM pg_attribute pa
        WHERE pa.attrelid = con.confrelid
          AND pa.attnum = ANY(con.confkey)
          AND pa.attname = 'id'
      )
    ```
  * For each discovered FK column/table pair, execute `DELETE FROM {table} WHERE {column} = $mediaId`.
  * All of the above runs inside a single transaction — if any step fails, the entire operation rolls back (neither the tag nor the deletes persist).
3.) This approach is schema-aware: when a new table adds a FK to `media_metadata.id`, it is automatically covered without code changes.


createHeygenMedia(options: CreateHeygenMediaOptions): Promise<MediaMetaData[]>

1.) Validate options at runtime with validateCreateHeygenMediaOptions(). If it fails, log WARN and let the BadRequestException propagate.

2.) For each item in options.items:
  a.) Assert enum values: assertValidMediaType(item.media_type), assertValidMediaSource('heygen').
  b.) Create a media_metadata database row:
    * id = uuid()
    * state_transition_id = item.state_transition_id
    * wa_media_url = NULL (set later by WHATSAPP_PRELOAD worker)
    * status = 'created'
    * media_type = item.media_type
    * source = 'heygen'
    * user_id = NULL (HeyGen media is not user-scoped)
    * rolled_back = false
    * generation_request_json = the sanitized item payload (no secrets — strip any avatar_id / voice_id that match env defaults, keep the rest)
  c.) Build a BullMQ job payload:
    {
      media_metadata_id: the row's id,
      media_type: item.media_type,
      heygen_params: {
        script_text: item.script_text,
        avatar_id: item.avatar_id,        // undefined if not overridden
        avatar_style: item.avatar_style,
        voice_id: item.voice_id,           // undefined if not overridden
        speed: item.speed,
        emotion: item.emotion,
        locale: item.locale,
        language: item.language,
        title: item.title,
        dimension: item.dimension,
        background: item.background,
      }
    }
  d.) Collect the row and job payload.

3.) Enqueue all job payloads atomically using queue.addBulk() on the HEYGEN_GENERATE queue.
  * If addBulk() fails: retry with exponential backoff (10s cap).
    * If the cap is reached:
      - Mark ALL created media_metadata rows as status = 'failed' (batch update).
      - Log ERROR.
      - Throw an InternalServerErrorException.

4.) Once addBulk() succeeds: update all created media_metadata rows to status = 'queued' (batch update).

5.) Return the created media_metadata entities (with status = 'queued').
