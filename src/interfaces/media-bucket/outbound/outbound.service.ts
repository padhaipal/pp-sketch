import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { v4 as uuid } from 'uuid';
import { Readable } from 'stream';

@Injectable()
export class MediaBucketService {
  private readonly logger = new Logger(MediaBucketService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = process.env.MEDIA_BUCKET_NAME!;
    this.s3 = new S3Client({
      endpoint: process.env.MEDIA_BUCKET_ENDPOINT,
      region: process.env.MEDIA_BUCKET_REGION ?? 'auto',
      credentials: {
        accessKeyId: process.env.MEDIA_BUCKET_ACCESS_KEY!,
        secretAccessKey: process.env.MEDIA_BUCKET_SECRET_KEY!,
      },
      forcePathStyle: true,
    });
  }

  async stream(
    readable: NodeJS.ReadableStream,
    content_type: string,
  ): Promise<string> {
    const key = uuid();
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: content_type,
        }),
      );
      return key;
    } catch (err) {
      this.logger.error(
        `S3 upload failed for key ${key}: ${(err as Error).message}`,
      );
      throw err;
    }
  }

  async getBuffer(
    s3_key: string,
  ): Promise<{ buffer: Buffer; content_type: string }> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: s3_key,
        }),
      );
      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return {
        buffer: Buffer.concat(chunks),
        content_type: response.ContentType ?? 'application/octet-stream',
      };
    } catch (err) {
      this.logger.error(
        `S3 getBuffer failed for key ${s3_key}: ${(err as Error).message}`,
      );
      throw err;
    }
  }
}
