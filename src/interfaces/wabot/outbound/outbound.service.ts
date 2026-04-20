import { Injectable, Logger } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import type { OtelCarrier } from '../../../otel/otel.dto';
import { tracer } from '../../../otel/otel';
import {
  OutboundMediaItem,
  SendMessageRequest,
  SendMessageResponse,
  SendNotificationRequest,
  SendNotificationResponse,
  UploadMediaResponse,
} from './outbound.dto';

@Injectable()
export class WabotOutboundService {
  private readonly logger = new Logger(WabotOutboundService.name);
  private readonly baseUrl = process.env.WABOT_INTERNAL_BASE_URL!;
  private readonly apiKey = process.env.WABOT_API_KEY!;

  async sendMessage(options: {
    user_external_id: string;
    wamid: string;
    consecutive?: boolean;
    media: OutboundMediaItem[];
    otel_carrier: OtelCarrier;
  }): Promise<{ status: number; body: SendMessageResponse }> {
    return tracer.startActiveSpan(
      'wabot.outbound.sendMessage',
      async (span) => {
        span.setAttribute('wabot.endpoint', 'sendMessage');
        span.setAttribute('wabot.user.external_id', options.user_external_id);
        span.setAttribute('wabot.wamid', options.wamid);

        try {
          const requestBody: SendMessageRequest = {
            user_external_id: options.user_external_id,
            wamid: options.wamid,
            consecutive: options.consecutive,
            media: options.media,
            otel: { carrier: options.otel_carrier },
          };

          let response: Response;
          try {
            response = await fetch(`${this.baseUrl}/sendMessage`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
              },
              body: JSON.stringify(requestBody),
            });
          } catch (err) {
            this.logger.error(
              `WabotOutbound.sendMessage fetch threw: ${(err as Error).message}`,
            );
            throw err;
          }
          span.setAttribute('http.response.status_code', response.status);
          const body = (await response.json()) as SendMessageResponse;
          return { status: response.status, body };
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
      },
    );
  }

  async sendNotification(options: {
    user_external_id: string;
    media: OutboundMediaItem[];
  }): Promise<SendNotificationResponse> {
    return tracer.startActiveSpan(
      'wabot.outbound.sendNotification',
      async (span) => {
        span.setAttribute('wabot.endpoint', 'sendNotification');
        span.setAttribute('wabot.user.external_id', options.user_external_id);

        try {
          const requestBody: SendNotificationRequest = {
            user_external_id: options.user_external_id,
            media: options.media,
          };

          let response: Response;
          try {
            response = await fetch(`${this.baseUrl}/sendNotification`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.apiKey,
              },
              body: JSON.stringify(requestBody),
            });
          } catch (err) {
            this.logger.error(
              `WabotOutbound.sendNotification fetch threw: ${(err as Error).message}`,
            );
            throw err;
          }
          span.setAttribute('http.response.status_code', response.status);
          return (await response.json()) as SendNotificationResponse;
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
      },
    );
  }

  async downloadMedia(
    media_url: string,
    otel_carrier: OtelCarrier,
  ): Promise<{ stream: NodeJS.ReadableStream; content_type: string }> {
    return tracer.startActiveSpan(
      'wabot.outbound.downloadMedia',
      async (span) => {
        span.setAttribute('wabot.endpoint', 'downloadMedia');

        try {
          const response = await fetch(`${this.baseUrl}/downloadMedia`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.apiKey,
            },
            body: JSON.stringify({
              media_url,
              otel: { carrier: otel_carrier },
            }),
          });
          span.setAttribute('http.response.status_code', response.status);

          if (response.status >= 400 && response.status < 500) {
            this.logger.error(
              `download-media 4XX: ${response.status} for ${media_url}`,
            );
            throw new Error(`download-media failed with ${response.status}`);
          }
          if (response.status >= 500) {
            this.logger.warn(
              `download-media 5XX: ${response.status} for ${media_url}`,
            );
            throw new Error(`download-media failed with ${response.status}`);
          }

          const content_type =
            response.headers.get('content-type') ?? 'application/octet-stream';

          return {
            stream: response.body! as unknown as NodeJS.ReadableStream,
            content_type,
          };
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
      },
    );
  }

  async uploadMedia(
    data: Buffer,
    content_type: string,
    media_type: string,
    otel_carrier: OtelCarrier,
  ): Promise<{ wa_media_url: string }> {
    return tracer.startActiveSpan(
      'wabot.outbound.uploadMedia',
      async (span) => {
        span.setAttribute('wabot.endpoint', 'uploadMedia');
        span.setAttribute('wabot.media_type', media_type);

        try {
          const otelParam = encodeURIComponent(JSON.stringify(otel_carrier));
          const url = `${this.baseUrl}/uploadMedia?otel=${otelParam}`;
          const ab = new ArrayBuffer(data.byteLength);
          new Uint8Array(ab).set(data);
          let response: Response;
          try {
            response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': content_type,
                'X-Media-Type': media_type,
                'x-api-key': this.apiKey,
              },
              body: ab,
            });
          } catch (err) {
            this.logger.error(
              `fetch to ${this.baseUrl}/uploadMedia threw network error: ${(err as Error).message}`,
            );
            throw err;
          }
          span.setAttribute('http.response.status_code', response.status);

          if (response.status >= 400 && response.status < 500) {
            const text = await response.text();
            this.logger.error(
              `uploadMedia 4XX: ${response.status} body=${text}`,
            );
            throw new Error(`uploadMedia failed with ${response.status}`);
          }
          if (response.status >= 500) {
            const text = await response.text();
            this.logger.warn(
              `uploadMedia 5XX: ${response.status} body=${text}`,
            );
            throw new Error(`uploadMedia failed with ${response.status}`);
          }

          const body = (await response.json()) as UploadMediaResponse;
          return { wa_media_url: body.wa_media_url };
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
      },
    );
  }
}
