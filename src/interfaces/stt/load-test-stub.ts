import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';
import {
  MediaMetaData,
  MediaSource,
  assertValidMediaSource,
  assertValidMediaStatus,
  assertValidMediaType,
} from '../../media-meta-data/media-meta-data.dto';

// Load-test stub. Phones with the configured prefix short-circuit the STT
// provider's HTTPS call so artillery scenarios in staging.yml don't spend
// Sarvam/Azure/Reverie quota. The canned transcript row is still written to
// media_metadata so downstream consumers behave identically to a real
// transcription.

const STUB_TRANSCRIPT = '<load-test stub transcript>';

export function isLoadTestUser(userExternalId: string | undefined): boolean {
  const prefix = process.env.LOAD_TEST_PHONE_PREFIX;
  if (!prefix || prefix.length === 0) return false;
  return (
    typeof userExternalId === 'string' && userExternalId.startsWith(prefix)
  );
}

export async function loadTestDelay(): Promise<void> {
  const ms = 200 + Math.floor(Math.random() * 200);
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function saveStubTranscript(
  repo: Repository<MediaMetaDataEntity>,
  parentMedia: MediaMetaData,
  source: MediaSource,
): Promise<MediaMetaData> {
  assertValidMediaType('text');
  assertValidMediaSource(source);
  assertValidMediaStatus('ready');

  const entity = repo.create({
    id: uuid(),
    media_type: 'text',
    source,
    status: 'ready',
    text: STUB_TRANSCRIPT,
    input_media_id: parentMedia.id,
    user_id: parentMedia.user_id,
    rolled_back: false,
    media_details: { load_test_stub: true },
  });
  return await repo.save(entity);
}
