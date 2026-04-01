// pp-sketch/src/interfaces/media-bucket/outbound/outbound.service.prompt.md

// S3-compatible object store client for the media-bucket.
// Bucket name: MEDIA_BUCKET_NAME (.env).
// S3 connection: MEDIA_BUCKET_ENDPOINT, MEDIA_BUCKET_ACCESS_KEY, MEDIA_BUCKET_SECRET_KEY (.env).
// Used by: createWhatsappAudioMedia (audio upload), HeyGen inbound processor (video upload), HeyGen outbound service (TTS audio upload), uploadStaticMedia (dashboard image/video upload), WHATSAPP_PRELOAD worker (download).

stream(readable: NodeJS.ReadableStream, content_type: string): Promise<string>
// Uploads a readable stream to S3. Returns the S3 object key.
// 1.) Generate a UUID v4 as the S3 object key.
// 2.) Upload via S3 PutObject (or multipart upload for large files) with:
//     * Key = the generated UUID
//     * Body = readable
//     * ContentType = content_type
// 3.) On success: return the UUID key.
// 4.) On S3 error: log ERROR and throw.

getBuffer(s3_key: string): Promise<{ buffer: Buffer; content_type: string }>
// Fetches an object from S3 by key and returns the full contents as a Buffer.
// content_type is read from the S3 object's ContentType metadata.
// Used by: WHATSAPP_PRELOAD worker to retrieve media before uploading to WhatsApp.
// On S3 error (e.g. NoSuchKey): log ERROR and throw.

delete(s3_key: string): Promise<void>
// Deletes an object from S3 by key.
// Used by: markRolledBack() for S3 cleanup after DB rollback.
// On S3 error: log ERROR and throw.
