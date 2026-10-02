import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { SpanStatusCode } from '@opentelemetry/api';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { MediaMetaDataEntity } from '../../../media-meta-data/media-meta-data.entity';
import {
  MediaMetaData,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
} from '../../../media-meta-data/media-meta-data.dto';
import { sttRequestDuration, type SttOutcome } from '../../../otel/metrics';
import { tracer } from '../../../otel/otel';
import {
  isLoadTestUser,
  loadTestDelay,
  saveStubTranscript,
} from '../load-test-stub';
import { oggOpusToWav16k, warmUpOpusDecoder } from './opus-to-wav';

export const BODHAN_STT_URL = 'https://api.bodhan.ai/v1/audio/transcriptions';
export const BODHAN_STT_MODEL = 'indic-transcribe';
// Bodhan rejects audio over 30 s. Clips of 29 s or more are never sent
// (outcome 'rejected', no network call) — the margin covers rounding and
// Bodhan's own duration measurement; the other engines still transcribe
// the note. Product decision 2026-10-02.
export const BODHAN_MAX_AUDIO_MS = 29_000;

// Per-key allowances Bodhan returns on every response (not documented as
// numbers anywhere — "read them off the response rather than hardcoding").
const RATE_LIMIT_HEADERS = [
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-limit-parallel-requests',
  'x-ratelimit-remaining-parallel-requests',
  'retry-after',
] as const;

/**
 * Bodhan.ai speech-to-text (indic-transcribe). Sits beside Sarvam / Azure /
 * Reverie in createWhatsappAudioMedia's fan-out; one text row per call,
 * source 'bodhan'. Env: BODHAN_API_KEY (a Bodhan key is per model — this one
 * is the indic-transcribe key), STT_TIME_CAP (seconds, shared by all STT).
 *
 * Unlike the other engines this branch uploads 16 kHz mono WAV: Bodhan's
 * vendor rejects WhatsApp's Ogg/Opus (502 after 5–6 s, measured 2026-10-02)
 * but transcribes WAV in ~1.5 s. The decode (opus-to-wav.ts, a few ms) runs
 * inside this branch only, after the other engines are already in flight.
 *
 * Observability: span `stt.bodhan` (status, rate-limit headers, outcome),
 * histogram pp.stt.request_duration_ms{provider="bodhan",outcome}, and WARN
 * logs carrying the Bodhan error body. 429 is logged with retry-after so a
 * too-low per-key allowance is visible from Loki on day one.
 */
@Injectable()
export class BodhanService implements OnModuleInit {
  private readonly logger = new Logger(BodhanService.name);
  // Logged once per process so the key's allowance is in Loki after boot.
  private allowanceLogged = false;

  constructor(
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
  ) {}

  // Compile the Opus WASM at boot so the first voice note doesn't pay for
  // it. Never fatal: a failure is logged and the first call retries.
  onModuleInit(): void {
    void warmUpOpusDecoder().catch((err: unknown) => {
      this.logger.warn(
        `Bodhan: opus decoder warm-up failed: ${(err as Error).message}`,
      );
    });
  }

  async run(
    audioBuffer: Buffer,
    parentMedia: MediaMetaData,
    userExternalId?: string,
  ): Promise<MediaMetaData> {
    if (audioBuffer.length === 0) {
      this.logger.warn(`Bodhan: empty audio buffer for ${parentMedia.id}`);
      throw new Error('Empty audio buffer');
    }

    if (isLoadTestUser(userExternalId)) {
      await loadTestDelay();
      return saveStubTranscript(this.mediaRepo, parentMedia, 'bodhan');
    }

    return tracer.startActiveSpan('stt.bodhan', async (span) => {
      const startedAt = Date.now();
      let outcome: SttOutcome = 'error';
      span.setAttribute('stt.provider', 'bodhan');
      span.setAttribute('stt.model', BODHAN_STT_MODEL);
      span.setAttribute('media.id', parentMedia.id);
      span.setAttribute('audio.bytes', audioBuffer.length);
      try {
        const out = await this.transcribe(audioBuffer, parentMedia, span);
        outcome = 'ok';
        return out;
      } catch (err) {
        outcome = (err as { sttOutcome?: SttOutcome }).sttOutcome ?? 'error';
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: (err as Error).message,
        });
        span.recordException(err as Error);
        throw err;
      } finally {
        span.setAttribute('stt.outcome', outcome);
        sttRequestDuration.record(Date.now() - startedAt, {
          provider: 'bodhan',
          outcome,
        });
        span.end();
      }
    });
  }

  private async transcribe(
    audioBuffer: Buffer,
    parentMedia: MediaMetaData,
    span: { setAttribute: (k: string, v: string | number) => unknown },
  ): Promise<MediaMetaData> {
    // 1. Ogg/Opus → WAV (this branch only). Errors here never reach the
    // network; they surface as outcome 'decode'.
    let wav: Buffer;
    let durationMs: number;
    try {
      ({ wav, durationMs } = await oggOpusToWav16k(audioBuffer));
    } catch (err) {
      this.logger.warn(
        `Bodhan: opus decode failed for ${parentMedia.id}: ${(err as Error).message}`,
      );
      throw withOutcome(
        new Error(`Bodhan STT failed: decode (${(err as Error).message})`),
        'decode',
      );
    }
    span.setAttribute('audio.duration_ms', durationMs);
    span.setAttribute('audio.wav_bytes', wav.length);

    // 2. Length gate: 29 s or longer is never sent (Bodhan would 415 after
    // ~5 s anyway, and the other engines cover the note).
    if (durationMs >= BODHAN_MAX_AUDIO_MS) {
      this.logger.warn(
        `Bodhan: clip ${durationMs}ms ≥ ${BODHAN_MAX_AUDIO_MS}ms for ${parentMedia.id} — not sent`,
      );
      throw withOutcome(
        new Error(`Bodhan STT failed: clip too long (${durationMs}ms)`),
        'rejected',
      );
    }

    // 3. POST the WAV. The time cap starts here, after decoding.
    const sttTimeCap = parseInt(process.env.STT_TIME_CAP ?? '5') * 1000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), sttTimeCap);

    const formData = new FormData();
    formData.append(
      'file',
      new Blob([Uint8Array.from(wav)], { type: 'audio/wav' }),
      `${parentMedia.id}.wav`,
    );
    formData.append('model', BODHAN_STT_MODEL);
    formData.append('language', 'hi');

    let response: Response;
    try {
      response = await fetch(BODHAN_STT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.BODHAN_API_KEY!}`,
        },
        body: formData,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      this.logger.warn(
        `Bodhan: network/timeout error for ${parentMedia.id}: ${(err as Error).message}`,
      );
      throw withOutcome(
        err as Error,
        controller.signal.aborted ? 'timeout' : 'network',
      );
    } finally {
      clearTimeout(timeout);
    }

    span.setAttribute('http.response.status_code', response.status);
    const limits = this.readRateLimitHeaders(response);
    for (const [k, v] of Object.entries(limits)) {
      span.setAttribute(`bodhan.${k}`, v);
    }
    if (!this.allowanceLogged && Object.keys(limits).length > 0) {
      this.allowanceLogged = true;
      this.logger.log(`Bodhan: key allowance ${JSON.stringify(limits)}`);
    }

    if (response.status === 429) {
      const body = await response.text();
      this.logger.warn(
        `Bodhan 429 for ${parentMedia.id}: rate-limited or out of credit (retry-after=${limits['retry-after'] ?? '?'}) ${body}`,
      );
      throw withOutcome(new Error(`Bodhan STT failed: 429`), 'rate_limited');
    }
    if (response.status === 415) {
      const body = await response.text();
      this.logger.warn(
        `Bodhan 415 for ${parentMedia.id}: duration unmeasurable or unsupported container ${body}`,
      );
      throw withOutcome(new Error(`Bodhan STT failed: 415`), 'rejected');
    }
    if (response.status >= 400 && response.status < 500) {
      const body = await response.text();
      this.logger.warn(
        `Bodhan 4XX for ${parentMedia.id}: ${response.status} ${body}`,
      );
      throw withOutcome(
        new Error(`Bodhan STT failed: ${response.status}`),
        'http_4xx',
      );
    }
    if (!response.ok) {
      const body = await response.text();
      this.logger.warn(
        `Bodhan 5XX for ${parentMedia.id}: ${response.status} ${body}`,
      );
      throw withOutcome(
        new Error(`Bodhan STT failed: ${response.status}`),
        'http_5xx',
      );
    }

    const result = (await response.json()) as { text?: string };
    if (typeof result.text !== 'string') {
      this.logger.warn(
        `Bodhan: no text in response for ${parentMedia.id}: ${JSON.stringify(result).slice(0, 200)}`,
      );
      throw withOutcome(new Error('Bodhan STT failed: no text'), 'error');
    }

    assertValidMediaType('text');
    assertValidMediaSource('bodhan');
    assertValidMediaStatus('ready');

    const entity = this.mediaRepo.create({
      id: uuid(),
      media_type: 'text',
      source: 'bodhan',
      status: 'ready',
      text: result.text,
      input_media_id: parentMedia.id,
      user_id: parentMedia.user_id,
      rolled_back: false,
      media_details: {
        model: BODHAN_STT_MODEL,
        language: 'hi',
        // What Bodhan actually received (the stored audio stays Ogg/Opus).
        upload_format: 'wav-16k-mono',
        upload_bytes: wav.length,
        duration_ms: durationMs,
        ...(Object.keys(limits).length > 0 && { rate_limit: limits }),
      },
    });

    return await this.mediaRepo.save(entity);
  }

  private readRateLimitHeaders(response: Response): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of RATE_LIMIT_HEADERS) {
      const v = response.headers?.get?.(h);
      if (v !== null && v !== undefined) out[h] = v;
    }
    return out;
  }
}

function withOutcome(err: Error, sttOutcome: SttOutcome): Error {
  (err as Error & { sttOutcome: SttOutcome }).sttOutcome = sttOutcome;
  return err;
}
