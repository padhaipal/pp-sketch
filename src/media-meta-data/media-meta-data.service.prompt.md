// pp-sketch/src/media-meta-data/media-meta-data.service.prompt.md
See src/docs/database.md for redis/database details and fallback patterns.
Inject CacheService from src/interfaces/redis/cache.ts. See cache.dto for key builders and TTLs.

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
* Hit pp-sketch/src/interfaces/wabot/outbound/outbound.service.ts/downloadMedia() with options.wa_media_url and get it to start streaming the audio file to this worker.
* Direct this byte flow to the following sinks. STT_TIME_CAP is a .env variable. 
  * src/media-bucket/outbound/outbound.service.ts/stream()
  * interfaces/stt/sarvam/sarvam.service.ts/run(), interfaces/stt/azure/azure.service.ts/run(), interfaces/stt/reverie/reverie.service.ts/run(), etc (as turned on and off by feature flags, see docs). Each run() receives the audio mediaMetaData entity and sets input_media_id on the text entity it creates.
* All of these streams will be processed in parallel asynchronously.
  * If the byte flow to the S3 bucket fails then stop all streaming immediately, make a db hit to mark this mediaMetaData entity as 'failed', log a WARN and stop this worker and mark it such that BullMQ retries it. 
  * If the byte flow to the S3 bucket succeeds but all of the speech to text ais either time out or fail then make a db hit to mark this mediaMetaData entity as 'failed', log a WARN and stop this worker and mark it such that BullMQ retries it.
  * Else: Wait until all streams are finished, error or timeout. 
    * src/media-bucket/outbound/outbound.service.ts/stream() should return the S3 bucket location for this media resource.
    * Each interfaces/stt/*/*.service.ts/run() will return either a mediaMetaData entity or its id.
5.) Update the audio mediaMetaData row (single row update):
* update s3_key
* update the mediaDetails field
* Update status to 'ready'
6.) Return the newly created mediaMetadata entity.

## createTextMedia(options: CreateTextMediaOptions): Promise<MediaMetaData>

Creates a text media_metadata row. Used by: inbound processor (WhatsApp text messages) and STT services (transcripts). No S3 upload — the row is immediately 'ready'.

1.) Validate options at runtime with validateCreateTextMediaOptions(). If it fails, log WARN and let the BadRequestException propagate.
2.) Resolve the user (exactly one identifier was provided):
  * If options.user is provided, use its .id as user_id directly (trusted, no DB hit).
  * If options.user_external_id is provided, call user.service.ts/find() to resolve user_id. If not found, log ERROR and throw.
3.) Determine source: options.source ?? 'whatsapp'. Assert enums: assertValidMediaType('text'), assertValidMediaSource(source), assertValidMediaStatus('ready').
4.) INSERT a new media_metadata row: id = uuid(), text = options.text, status = 'ready', media_type = 'text', source = resolved source, user_id = resolved user_id, input_media_id = options.input_media_id ?? NULL, media_details = options.media_details ?? NULL, rolled_back = false. All other columns NULL.
5.) Return the created entity.

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

Looks up all ready, deliverable media entities whose `state_transition_id` matches the given `stateTransitionId`, then randomly selects one entity per media type. Falls back per-media-type to a generic key when the specific key has no row of that type. Uses the `(state_transition_id, status)` index.

Generic key derivation: replace the substring before the first `-` with `_`. Example: `शब्द-start-word-initial` → `_-start-word-initial`. If `stateTransitionId` contains no `-`, there is no generic key — skip the fallback entirely.

1.) If `stateTransitionId` is not a valid non-empty string, throw BadRequestException.
2.) Compute `genericKey` (or null if no `-`).
3.) Check cache: call `cacheService.get<FindMediaByStateTransitionIdResult>(CACHE_KEYS.mediaByStateTransitionId(stateTransitionId))`.
  * If cache hit: return immediately (no DB hit). The cached value already encodes any generic fallbacks resolved on a previous call.
4.) Query (single DB round-trip — use `= ANY($1::text[])` so both keys are fetched together; pass `[stateTransitionId]` if `genericKey` is null):
  ```sql
  SELECT * FROM media_metadata
  WHERE state_transition_id = ANY($1::text[])
    AND status = 'ready'
    AND (wa_media_url IS NOT NULL OR media_type = 'text')
  ```
5.) Partition rows into two groups by `state_transition_id`: specific-rows and generic-rows. Within each group, sub-group by `media_type`.
6.) For each media type (audio, video, text, image):
  * If specific-rows has one or more entries of that type, randomly select one from specific-rows.
  * Else if generic-rows has one or more entries of that type, randomly select one from generic-rows.
  * Else omit the key.
7.) If the result is non-empty, cache it under the **specific** key only with `cacheService.set(CACHE_KEYS.mediaByStateTransitionId(stateTransitionId), result, CACHE_TTL.MEDIA_BY_STATE_TRANSITION)`. Do not write a separate generic-key cache entry.
8.) Return the `FindMediaByStateTransitionIdResult` object.

## markRolledBack(mediaId: string): Promise<void>

Atomically tags the media_metadata row as rolled back AND deletes every row in every table that references it via a foreign key. Both operations happen inside a single transaction so the tag and the deletions are all-or-nothing.

1.) If `mediaId` is not a valid non-empty string, throw BadRequestException.
2.) Fetch the `s3_key` from the media_metadata row before the DB transaction.
3.) Execute the following as a single database call using a plpgsql anonymous block (or a stored function):
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
  * For each discovered FK column/table pair, execute `EXECUTE format('DELETE FROM %I WHERE %I = $1', referencing_table, referencing_column) USING mediaId` — the `%I` specifier in plpgsql's `format()` quotes identifiers safely.
  * All of the above runs inside a single transaction — if any step fails, the entire operation rolls back (neither the tag nor the deletes persist).
4.) This approach is schema-aware: when a new table adds a FK to `media_metadata.id`, it is automatically covered without code changes.
5.) After DB commit, if `s3_key` exists, delete the S3 object via `mediaBucket.delete(s3_key)`. Best-effort: on failure, log WARN but do not throw (worst case is an orphaned S3 object).


createHeygenMedia(options: CreateHeygenMediaOptions, otel_carrier: Record<string, string>): Promise<MediaMetaData[]>

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
      otel_carrier: otel_carrier,
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


createElevenlabsMedia(options: CreateElevenlabsMediaOptions, otel_carrier: Record<string, string>): Promise<MediaMetaData[]>

Identical pattern to createHeygenMedia, but source = 'elevenlabs', media_type always 'audio', queue = ELEVENLABS_GENERATE.

1.) Validate with validateCreateElevenlabsMediaOptions().

2.) For each item in options.items:
  a.) Assert enums: assertValidMediaType('audio'), assertValidMediaSource('elevenlabs').
  b.) Create media_metadata row:
    * id = uuid(), state_transition_id, wa_media_url = NULL, status = 'created',
      media_type = 'audio', source = 'elevenlabs', user_id = NULL, rolled_back = false,
      generation_request_json = sanitized item payload (no secrets — strip voice_id matching env default)
  c.) Build BullMQ job payload:
    {
      media_metadata_id: row id,
      otel_carrier,
      elevenlabs_params: {
        script_text, voice_id, model_id, language_code, voice_settings
      }
    }

3.) Enqueue all jobs via queue.addBulk() on ELEVENLABS_GENERATE queue.
  * Retry with exponential backoff (10s cap). On cap: mark all rows 'failed', log ERROR, throw.

4.) Update all rows to status = 'queued'.

5.) Return entities (status = 'queued').


uploadStaticMedia(files: Express.Multer.File[], items: UploadStaticMediaItem[], otel_carrier: Record<string, string>): Promise<UploadStaticMediaResult>

Creates admin-supplied static media_metadata rows. Handles two flows:
  * Non-text items (image/video/audio): upload bytes to S3, INSERT/UPDATE row (status 'created' → 'queued'), enqueue WHATSAPP_PRELOAD.
  * Text items: no S3 upload, no preload — INSERT row directly with status 'ready' and the inline `text` field.
Processes items sequentially in items[] order. Files are matched to non-text items in order: maintain a running `fileCursor` that advances only when the current item is non-text; files[fileCursor] is the file for the current non-text item.
Dedup (non-text only): SHA-256 content hash + state_transition_id prevents re-uploading identical bytes for the same transition.
Dedup (text): state_transition_id + media_type='text' + text content prevents inserting an identical text row twice.

For each item at index i:

  --- Text item branch (items[i].media_type === 'text') ---

  T1.) Assert enums: assertValidMediaType('text'), assertValidMediaSource('dashboard').

  T2.) Dedup check (single DB query):
      ```sql
      SELECT * FROM media_metadata
      WHERE state_transition_id = $state_transition_id
        AND media_type = 'text'
        AND text = $text
      LIMIT 1
      ```
      * If found with status 'ready': collect { index: i, status: 'duplicate_skipped', entity: existingRow }. Continue to next item.
      * If found with status 'failed': reuse this row — UPDATE to status='ready', rolled_back=false. Continue to T4.
      * If not found: continue to T3.

  T3.) INSERT new row: id = uuid(), state_transition_id = items[i].state_transition_id, media_type = 'text', source = 'dashboard', status = 'ready', text = items[i].text, s3_key = NULL, content_hash = NULL, wa_media_url = NULL, user_id = NULL, rolled_back = false, media_details = NULL.
      * If PG write throws: log WARN (index, error). Collect as 'failed'. Continue to next item.

  T4.) Collect { index: i, status: 'created', entity: row (status 'ready') }. Continue to next item. (Do NOT advance fileCursor.)

  --- Non-text item branch (image/video/audio) ---

  Let f = files[fileCursor].

  1.) Compute SHA-256 hex digest of f.buffer → content_hash.

  2.) Infer media_type from f.mimetype using MIME_TO_MEDIA_TYPE. It must equal items[i].media_type — if not, collect 'failed' with mismatch error and continue.
      Assert enums: assertValidMediaType(media_type), assertValidMediaSource('dashboard').

  3.) Dedup check (single DB query):
      ```sql
      SELECT * FROM media_metadata
      WHERE content_hash = $content_hash
        AND state_transition_id = $state_transition_id
      LIMIT 1
      ```
      * If found with status 'created', 'queued', or 'ready': collect { index: i, status: 'duplicate_skipped', entity: existingRow }. Advance fileCursor. Continue to next item.
      * If found with status 'failed': reuse this row — continue to step 4 (re-upload to S3 and re-enqueue). The existing row's id is preserved; s3_key, media_details, and status will be overwritten in step 5.
      * If not found: continue to step 4 (create new row).

  4.) Upload to S3: call media-bucket stream(Readable.from(f.buffer), f.mimetype). Returns s3_key.
      * If stream() throws: log WARN (index, error, items[i].state_transition_id). Collect 'failed'. Advance fileCursor. Continue to next item.

  5.) Create or update media_metadata row:
      * If reusing a failed row from step 3: UPDATE the existing row — set s3_key = returned key, status = 'created', media_details = { mime_type: f.mimetype, byte_size: f.size }, rolled_back = false.
      * If creating new: INSERT with id = uuid(), state_transition_id = items[i].state_transition_id, s3_key = returned key, content_hash = computed hash, wa_media_url = NULL (set later by WHATSAPP_PRELOAD worker), media_type = inferred type, source = 'dashboard', status = 'created', user_id = NULL, rolled_back = false, media_details = { mime_type: f.mimetype, byte_size: f.size }, text = NULL.
      * If PG write throws: log WARN (index, error). Collect as 'failed'. Advance fileCursor. Continue to next item.

  6.) Enqueue WHATSAPP_PRELOAD job:
      { media_metadata_id: row.id, s3_key, reload: false, otel_carrier }.
      * If enqueue throws: log WARN. Update row status to 'failed'. Collect 'failed'. Advance fileCursor. Continue to next item.

  7.) Update media_metadata status to 'queued'.

  8.) Collect { index: i, status: 'created', entity: row (with status 'queued') }. Advance fileCursor.

After all items processed:
  Compute summary: { created: count('created'), duplicate_skipped: count('duplicate_skipped'), failed: count('failed') }.
  Return { results, summary }.
