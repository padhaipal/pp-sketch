// pp-sketch/src/mediaMetaData/mediaMetaData.service.prompt.md
See src/docs/database.md for redis/database details and fallback patterns.

Enum enforcement: MediaStatus, MediaType, and MediaSource are stored as plain text in pg (no custom pg enum types).
All writes and updates MUST call the assertion helpers (assertValidMediaStatus, assertValidMediaType, assertValidMediaSource) from mediaMetaData.dto before touching the database, so that adding or removing enum values is a code-only change.

createWhatsappAudioMedia(options: CreateWhatsappAudioMediaOptions): Promise<MediaMetaData>
1.) Validate options at runtime with validateCreateWhatsappAudioMediaOptions(). If it fails, log WARN and let the BadRequestException propagate.
2.) Resolve the user (exactly one identifier was provided):
  * If options.user is provided, use its .id as user_id directly (trusted, no DB hit).
  * If options.user_external_id is provided, call user.service.ts/find() to resolve user_id. If not found, log ERROR and throw.
3.) Check if a mediaMetaData row with this external_id already exists in the database.
  * If it exists and its status is 'failed', reuse that row: update its status to 'created' and continue to step 4.
  * If it exists and its status is anything other than 'failed', log WARN and return the existing entity (no-op).
  * If it does not exist, create a new mediaMetaData database row with status = 'created'.
4.)
* Hit pp-sketch/src/wabot/outbound/outbound.service.ts/downloadMedia() and get it to start streaming the audio file to this worker.
* Direct this byte flow to the following sinks. STT_TIME_CAP is a .env variable. 
  * src/mediaBucket/outbound/outbound.service.ts/stream()
  * mediaMetaData/sttSarvam.service.ts/run(), mediaMetaData/sttAzure.service.ts/run(), mediaMetaData/sttReverie.service.ts/run(), etc (as turned on and off by feature flags, see docs).
* All of these streams will be processed in parallel asynchronously.
  * If the byte flow to the S3 bucket fails then stop all streaming immediately, make a db hit to mark this mediaMetaData entity as 'failed', log a WARN and stop this worker and mark it such that BullMQ retries it. 
  * If the byte flow to the S3 bucket succeeds but all of the speech to text ais either time out or fail then make a db hit to mark this mediaMetaData entity as 'failed', log a WARN and stop this worker and mark it such that BullMQ retries it.
  * Else: Wait until all streams are finished, error or timeout. 
    * src/mediaBucket/outbound/outbound.service.ts/stream() should return the S3 bucket location for this media resource.
    * Each mediaMetaData/sttXXX.service.ts/run() will return either a mediaMetaData entity or its id.
5.) Atomically hit the database and do the following be efficient (try to do this in one db hit if possible). 
* update s3_key
* update the mediaDetails field
* link each of the STT generated mediaMetaData entities to the audio mediaMetaData entity.
* Update status to 'ready'
6.) Return the newly created mediaMetadata entity.

createHeygenMedia(options: CreateHeygenMediaOptions[]): Promise<MediaMetaData[]>
// TODO: define when heygen integration is built
