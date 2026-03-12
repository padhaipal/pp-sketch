// pp-sketch/src/media-meta-data/stt-azure.service.prompt.md
// Azure speech-to-text service.
// run() receives an audio byte stream and the parent audio MediaMetaData entity.
// Creates a text MediaMetaData entity (source='azure', input_media_id=parent.id).
// Returns the created MediaMetaData entity.
// TODO: define Azure STT API integration, timeout handling (STT_TIME_CAP), error handling.
