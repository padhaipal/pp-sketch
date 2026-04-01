import { Injectable, Logger } from '@nestjs/common';
import type { OtelCarrier } from '../../../otel/otel.dto';
import {
  OutboundMediaItem,
  SendMessageRequest,
  SendMessageResponse,
  UploadMediaResponse,
} from './outbound.dto';

@Injectable()
export class WabotOutboundService {
  private readonly logger = new Logger(WabotOutboundService.name);
  private readonly baseUrl = process.env.WABOT_INTERNAL_BASE_URL!;

  async sendMessage(options: {
    user_external_id: string;
    wamid: string;
    consecutive?: boolean;
    media: OutboundMediaItem[];
    otel_carrier: OtelCarrier;
  }): Promise<{ status: number; body: SendMessageResponse }> {
    const requestBody: SendMessageRequest = {
      user_external_id: options.user_external_id,
      wamid: options.wamid,
      consecutive: options.consecutive,
      media: options.media,
      otel: { carrier: options.otel_carrier },
    };

    const response = await fetch(`${this.baseUrl}/pp/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const body = (await response.json()) as SendMessageResponse;
    return { status: response.status, body };
  }

  async downloadMedia(
    media_url: string,
    otel_carrier: OtelCarrier,
  ): Promise<{ stream: NodeJS.ReadableStream; content_type: string }> {
    const response = await fetch(`${this.baseUrl}/pp/download-media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_url,
        otel: { carrier: otel_carrier },
      }),
    });

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
  }

  async uploadMedia(
    data: Buffer,
    content_type: string,
    media_type: string,
    otel_carrier: OtelCarrier,
  ): Promise<{ wa_media_url: string }> {
    const otelParam = encodeURIComponent(JSON.stringify(otel_carrier));
    const url = `${this.baseUrl}/pp/upload-media?otel=${otelParam}`;
    this.logger.log(
      `[v2] POST ${this.baseUrl}/pp/upload-media content_type=${content_type} media_type=${media_type} body_size=${data.byteLength}`,
    );
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': content_type,
          'X-Media-Type': media_type,
        },
        body: ab,
      });
    } catch (err) {
      this.logger.error(
        `[v2] fetch to ${this.baseUrl}/pp/upload-media threw network error: ${(err as Error).message}`,
      );
      throw err;
    }

    this.logger.log(`[v2] uploadMedia response status=${response.status}`);

    if (response.status >= 400 && response.status < 500) {
      const text = await response.text();
      this.logger.error(`uploadMedia 4XX: ${response.status} body=${text}`);
      throw new Error(`uploadMedia failed with ${response.status}`);
    }
    if (response.status >= 500) {
      const text = await response.text();
      this.logger.warn(`uploadMedia 5XX: ${response.status} body=${text}`);
      throw new Error(`uploadMedia failed with ${response.status}`);
    }

    const body = (await response.json()) as UploadMediaResponse;
    return { wa_media_url: body.wa_media_url };
  }
}
