import { Logger } from '@nestjs/common';
import { SpanStatusCode, metrics } from '@opentelemetry/api';
import type { Job } from 'bullmq';
import type { DataSource } from 'typeorm';
import { createQueue, QUEUE_NAMES } from '../interfaces/redis/queues';
import type { WhatsappPreloadJobDto } from './media-meta-data.dto';
import { tracer, injectCarrier } from '../otel/otel';

const logger = new Logger('MediaReloadSweepProcessor');
const whatsappPreloadQueue = createQueue(QUEUE_NAMES.WHATSAPP_PRELOAD);

// WhatsApp media ids expire ~30 days after upload; re-upload at 20 to keep
// margin. Rows are eligible when overdue ('ready' + stamp older than 20d or
// never stamped) or stranded ('created'/'queued' for >6h — their first
// preload attempt gave up; the 6h guard avoids racing an in-flight one).
// Filters mirror the preload processor's own skip guards: never rolled_back,
// never 'failed' (permanent rejection), s3 file must exist, and stid-less
// one-shots (report cards) are unaddressable so re-uploading them is waste.
const ELIGIBLE_WHERE = `
  rolled_back = false
  AND s3_key IS NOT NULL
  AND state_transition_id IS NOT NULL
  AND (
    (status = 'ready'
      AND (wa_uploaded_at IS NULL OR wa_uploaded_at < now() - interval '20 days'))
    OR
    (status IN ('created', 'queued')
      AND created_at < now() - interval '6 hours')
  )`;

// Total rows currently eligible, including beyond this run's batch limit.
// The health signal: should fall from the initial backlog to ~steady-state
// (library size / 480 hourly runs per 20-day cycle) and stay there.
const meter = metrics.getMeter('pp.media_reload');
let lastBacklog = -1;
const backlogGauge = meter.createObservableGauge('pp.media_reload.backlog', {
  description:
    'Media rows currently eligible for re-upload (overdue or stranded).',
});
backlogGauge.addCallback((result) => {
  if (lastBacklog >= 0) result.observe(lastBacklog);
});

const ADD_BULK_CHUNK = 1000;

export async function processMediaReloadSweepJob(
  job: Job,
  dataSource: DataSource,
): Promise<void> {
  return tracer.startActiveSpan('media-reload-sweep', async (span) => {
    span.setAttribute('bullmq.job.id', String(job.id));
    try {
      const batchLimit = parseInt(
        process.env.MEDIA_RELOAD_SWEEP_BATCH ?? '9000',
        10,
      );
      span.setAttribute('sweep.batch_limit', batchLimit);

      const [{ count }]: { count: string }[] = await dataSource.query(
        `SELECT count(*) AS count FROM media_metadata WHERE ${ELIGIBLE_WHERE}`,
      );
      const backlog = parseInt(count, 10);
      lastBacklog = backlog;
      span.setAttribute('sweep.backlog', backlog);

      if (backlog === 0) {
        logger.log('media-reload-sweep: backlog 0 — nothing to do');
        return;
      }

      const rows: { id: string; s3_key: string; status: string }[] =
        await dataSource.query(
          `SELECT id, s3_key, status FROM media_metadata
           WHERE ${ELIGIBLE_WHERE}
           ORDER BY wa_uploaded_at ASC NULLS FIRST
           LIMIT $1`,
          [batchLimit],
        );

      // jobId dedupes re-selection within the hour; the bucket suffix lets
      // next hour retry a row whose job landed in the failed set (a bare
      // per-media id would be blocked by it forever).
      const hourBucket = Math.floor(Date.now() / 3_600_000);
      const reloadCount = rows.filter((r) => r.status === 'ready').length;
      const rescueCount = rows.length - reloadCount;

      for (let i = 0; i < rows.length; i += ADD_BULK_CHUNK) {
        const chunk = rows.slice(i, i + ADD_BULK_CHUNK);
        await whatsappPreloadQueue.addBulk(
          chunk.map((row) => ({
            name: `sweep-${row.id}`,
            data: {
              media_metadata_id: row.id,
              s3_key: row.s3_key,
              // Rescues (first upload never confirmed) must flip the row
              // to 'ready' on success; true reloads only refresh the url.
              reload: row.status === 'ready',
              otel_carrier: injectCarrier(span),
            } as WhatsappPreloadJobDto,
            opts: { jobId: `sweep-${row.id}-${hourBucket}` },
          })),
        );
      }

      span.setAttribute('sweep.selected', rows.length);
      span.setAttribute('sweep.reloads', reloadCount);
      span.setAttribute('sweep.rescues', rescueCount);
      logger.log(
        `media-reload-sweep: backlog=${backlog} selected=${rows.length} (reloads=${reloadCount}, rescues=${rescueCount}) limit=${batchLimit}`,
      );
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
