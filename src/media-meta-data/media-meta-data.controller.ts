import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import type { Response } from 'express';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiConsumes, ApiResponse, ApiBody } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MediaMetaDataEntity } from './media-meta-data.entity';
import { MediaMetaDataService } from './media-meta-data.service';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import {
  validateCreateHeygenMediaOptions,
  validateCreateElevenlabsMediaOptions,
  validateUploadStaticMediaItems,
  assertValidStaticMediaFile,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
} from './media-meta-data.dto';
import { v4 as uuid } from 'uuid';
import { startRootSpan, injectCarrier } from '../otel/otel';

@ApiTags('media-meta-data')
@Controller('media-meta-data')
export class MediaMetaDataController {
  constructor(
    private readonly mediaMetaDataService: MediaMetaDataService,
    private readonly mediaBucket: MediaBucketService,
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
  ) {}

  @Get(':id/audio')
  async getAudio(@Param('id') id: string, @Res() res: Response) {
    const media = await this.mediaRepo.findOneBy({ id });
    if (!media || !media.s3_key) {
      throw new NotFoundException('Media not found or no audio available');
    }
    const { buffer, content_type } = await this.mediaBucket.getBuffer(media.s3_key);
    res.set('Content-Type', content_type);
    res.set('Content-Length', buffer.length.toString());
    res.send(buffer);
  }

  @Post('heygen-generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBody({ schema: { type: 'object', properties: { items: { type: 'array' } } } })
  @ApiResponse({ status: 202 })
  async generateHeygenMedia(@Body() body: unknown) {
    const validated = validateCreateHeygenMediaOptions(body);
    const span = startRootSpan('heygen-generate-controller');
    try {
      const entities = await this.mediaMetaDataService.createHeygenMedia(
        validated,
        injectCarrier(span),
      );
      return { created: entities.length, entities };
    } finally {
      span.end();
    }
  }

  @Post('elevenlabs-generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBody({ schema: { type: 'object', properties: { items: { type: 'array' } } } })
  @ApiResponse({ status: 202 })
  async generateElevenlabsMedia(@Body() body: unknown) {
    const validated = validateCreateElevenlabsMediaOptions(body);
    const span = startRootSpan('elevenlabs-generate-controller');
    try {
      const entities = await this.mediaMetaDataService.createElevenlabsMedia(
        validated,
        injectCarrier(span),
      );
      return { created: entities.length, entities };
    } finally {
      span.end();
    }
  }

  @Post('upload-static')
  @HttpCode(HttpStatus.CREATED)
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201 })
  @UseInterceptors(FilesInterceptor('files', 50))
  async uploadStaticMedia(
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: Record<string, unknown>,
  ) {
    // Parse items from form field
    let rawItems: unknown;
    try {
      rawItems =
        typeof body.items === 'string'
          ? JSON.parse(body.items)
          : body.items;
    } catch {
      throw new BadRequestException('items must be valid JSON');
    }

    const validatedItems = validateUploadStaticMediaItems(rawItems);

    // Files are matched in order to non-text items only.
    const nonTextCount = validatedItems.filter(
      (item) => item.media_type !== 'text',
    ).length;
    const fileList = files ?? [];
    if (fileList.length !== nonTextCount) {
      throw new BadRequestException(
        `files length (${fileList.length}) must equal number of non-text items (${nonTextCount})`,
      );
    }
    for (let i = 0; i < fileList.length; i++) {
      assertValidStaticMediaFile(fileList[i], i);
    }

    const span = startRootSpan('upload-static-controller');
    try {
      const result = await this.mediaMetaDataService.uploadStaticMedia(
        files,
        validatedItems,
        injectCarrier(span),
      );
      return result;
    } finally {
      span.end();
    }
  }

  @Post(':id/dashboard-transcript')
  @HttpCode(HttpStatus.CREATED)
  async createDashboardTranscript(
    @Param('id') id: string,
    @Body() body: { text: string },
  ) {
    if (!body.text?.trim()) throw new BadRequestException('text required');

    const parent = await this.mediaRepo.findOneBy({ id });
    if (!parent) throw new NotFoundException('Media not found');

    const existing = await this.mediaRepo.findOneBy({
      input_media_id: id,
      source: 'dashboard' as any,
      media_type: 'text' as any,
    });
    if (existing) throw new BadRequestException('Dashboard transcript already exists');

    assertValidMediaType('text');
    assertValidMediaSource('dashboard');
    assertValidMediaStatus('ready');

    const entity = this.mediaRepo.create({
      id: uuid(),
      media_type: 'text',
      source: 'dashboard',
      status: 'ready',
      text: body.text.trim(),
      input_media_id: id,
      user_id: parent.user_id,
      rolled_back: false,
    });
    return this.mediaRepo.save(entity);
  }

  @Patch(':id/dashboard-transcript')
  async updateDashboardTranscript(
    @Param('id') id: string,
    @Body() body: { text: string },
  ) {
    if (!body.text?.trim()) throw new BadRequestException('text required');

    const transcript = await this.mediaRepo.findOneBy({
      input_media_id: id,
      source: 'dashboard' as any,
      media_type: 'text' as any,
    });
    if (!transcript) throw new NotFoundException('Dashboard transcript not found');

    transcript.text = body.text.trim();
    return this.mediaRepo.save(transcript);
  }

  @Delete(':id/dashboard-transcript')
  async deleteDashboardTranscript(@Param('id') id: string) {
    const transcript = await this.mediaRepo.findOneBy({
      input_media_id: id,
      source: 'dashboard' as any,
      media_type: 'text' as any,
    });
    if (!transcript) throw new NotFoundException('Dashboard transcript not found');

    await this.mediaRepo.remove(transcript);
    return { deleted: true };
  }
}
