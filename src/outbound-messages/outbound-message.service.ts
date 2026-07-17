import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { outboundRecordFailure } from '../otel/metrics';
import {
  OutboundTrigger,
  RecordSentOptions,
  OUTBOUND_TRIGGERS,
} from './outbound-message.dto';

@Injectable()
export class OutboundMessageService {
  private readonly logger = new Logger(OutboundMessageService.name);

  constructor(private readonly dataSource: DataSource) {}

  // Records what was actually sent to a user — one row per entity-backed
  // media item, batched into a single INSERT. Deliberately NEVER throws:
  // the audit log must not take down message delivery. A failed write emits
  // pp.outbound.record_failure_total + an ERROR log (a hole in the audit
  // trail, visible in Grafana) and the turn proceeds.
  async recordSent(options: RecordSentOptions): Promise<void> {
    const items = options.items ?? [];
    if (items.length === 0 || !options.user_id) {
      return;
    }
    const trigger: OutboundTrigger = OUTBOUND_TRIGGERS.includes(
      options.trigger as OutboundTrigger,
    )
      ? (options.trigger as OutboundTrigger)
      : 'other';

    try {
      const params: unknown[] = [
        options.user_id,
        options.user_message_id ?? null,
        trigger,
      ];
      const valueRows: string[] = [];
      for (const item of items) {
        const idIdx = params.push(uuid());
        const stidIdx = params.push(item.state_transition_id ?? null);
        const mediaIdx = params.push(item.media_metadata_id);
        valueRows.push(
          `($${idIdx}, $1, $2, $3, $${stidIdx}, $${mediaIdx}, 'sent', now())`,
        );
      }
      await this.dataSource.query(
        `INSERT INTO outbound_messages (id, user_id, user_message_id, "trigger", state_transition_id, media_metadata_id, status, created_at)
         VALUES ${valueRows.join(', ')}`,
        params,
      );
    } catch (err) {
      outboundRecordFailure.add(1, { trigger });
      this.logger.error(
        `recordSent FAILED (audit hole) user=${options.user_id} trigger=${trigger} items=${items.length}: ${(err as Error).message}`,
      );
    }
  }
}
