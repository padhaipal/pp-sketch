stream()
// Uploads a readable stream to S3. Returns the S3 object key.
// Used by: createWhatsappAudioMedia (audio upload), HeyGen inbound processor (video upload), HeyGen outbound service (TTS audio upload).

getBuffer(s3_key: string): Promise<{ buffer: Buffer; content_type: string }>
// Fetches an object from S3 by key and returns the full contents as a Buffer.
// content_type is read from the S3 object's ContentType metadata.
// Used by: WHATSAPP_PRELOAD worker to retrieve media before uploading to WhatsApp.
// On S3 error (e.g. NoSuchKey): log ERROR and throw.