// pp-sketch/src/mediaMetaData/mediaMetaData.service.prompt.md
See src/docs/database.md for redis/database details and fallback patterns.

create(options: CreateMediaMetaDataOptions): Promise<MediaMetaData>
1.) Validate options at runtime with validateCreateMediaMetaDataOptions(). If it fails, log WARN and let the BadRequestException propagate.
2.) Resolve the owner (exactly one side was provided):
  * If options.user is provided, use its .id as user_id directly (trusted, no DB hit).
  * If options.user_external_id is provided, call user.service.ts/find() to resolve user_id. If not found, log ERROR and throw.
  * If options.ai_provider is provided, use its .id as ai_provider_id directly (trusted, no DB hit). user_id is null.
  * If options.ai_provider_id is provided, verify via ai_provider lookup. If not found, log ERROR and throw. user_id is null.
3.) Download the media from options.source_url, upload it to the S3 media-bucket, and derive the s3_key.
4.) Insert one row into media_metadata with status = 'pending', the resolved user_id (or null), the derived s3_key, and all other provided fields.
5.) Return the newly created media_metadata entity.
