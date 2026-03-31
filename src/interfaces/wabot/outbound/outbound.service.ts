import { Injectable, Logger } from '@nestjs/common';
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
    otel_carrier: Record<string, string>;
  }): Promise<{ status: number; body: SendMessageResponse }> {
    const requestBody: SendMessageRequest = {
      user_external_id: options.user_external_id,
      wamid: options.wamid,
      consecutive: options.consecutive,
      media: options.media,
      otel: { carrier: options.otel_carrier },
    };

    const response = await fetch(`${this.baseUrl}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    const body = (await response.json()) as SendMessageResponse;
    return { status: response.status, body };
  }

  async downloadMedia(
    media_url: string,
    otel_carrier: Record<string, string>,
  ): Promise<{ stream: NodeJS.ReadableStream; content_type: string }> {
    const response = await fetch(`${this.baseUrl}/downloadMedia`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        media_url,
        otel: { carrier: otel_carrier },
      }),
    });

    if (response.status >= 400 && response.status < 500) {
      this.logger.error(
        `downloadMedia 4XX: ${response.status} for ${media_url}`,
      );
      throw new Error(`downloadMedia failed with ${response.status}`);
    }
    if (response.status >= 500) {
      this.logger.warn(
        `downloadMedia 5XX: ${response.status} for ${media_url}`,
      );
      throw new Error(`downloadMedia failed with ${response.status}`);
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
    otel_carrier: Record<string, string>,
  ): Promise<{ wa_media_url: string }> {
    const otelParam = encodeURIComponent(JSON.stringify(otel_carrier));
    const ab = new ArrayBuffer(data.byteLength);
    new Uint8Array(ab).set(data);
    const response = await fetch(
      `${this.baseUrl}/uploadMedia?otel=${otelParam}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': content_type,
          'X-Media-Type': media_type,
        },
        body: ab,
      },
    );

    if (response.status >= 400 && response.status < 500) {
      this.logger.error(`uploadMedia 4XX: ${response.status}`);
      throw new Error(`uploadMedia failed with ${response.status}`);
    }
    if (response.status >= 500) {
      this.logger.warn(`uploadMedia 5XX: ${response.status}`);
      throw new Error(`uploadMedia failed with ${response.status}`);
    }

    const body = (await response.json()) as UploadMediaResponse;
    return { wa_media_url: body.wa_media_url };
  }
}
