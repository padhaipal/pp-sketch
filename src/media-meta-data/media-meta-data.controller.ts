import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
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
import { MediaMetadataCoverageService } from './media-metadata-coverage.service';
import { MediaBucketService } from '../interfaces/media-bucket/outbound/outbound.service';
import {
  validateCreateHeygenMediaOptions,
  validateCreateElevenlabsMediaOptions,
  validateUploadStaticMediaItems,
  assertValidStaticMediaFile,
  assertValidMediaType,
  assertValidMediaSource,
  assertValidMediaStatus,
  DashboardTranscriptResponse,
  DeleteResponse,
  MediaMetadataCoverageResponse,
  MediaItemResponse,
} from './media-meta-data.dto';
import { v4 as uuid } from 'uuid';
import { startRootSpan, injectCarrier } from '../otel/otel';

@ApiTags('media-meta-data')
@Controller('media-meta-data')
export class MediaMetaDataController {
  constructor(
    private readonly mediaMetaDataService: MediaMetaDataService,
    private readonly coverageService: MediaMetadataCoverageService,
    private readonly mediaBucket: MediaBucketService,
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
  ) {}

  @Get('coverage')
  async getCoverage(): Promise<MediaMetadataCoverageResponse> {
    return this.coverageService.getCoverage();
  }

  @Get('by-state-transition-id')
  async listByStateTransitionId(
    @Query('state_transition_id') stid: string,
  ): Promise<MediaItemResponse[]> {
    if (!stid || typeof stid !== 'string') {
      throw new BadRequestException(
        'state_transition_id query param required',
      );
    }
    const rows = await this.mediaRepo.find({
      where: { state_transition_id: stid, rolled_back: false },
      order: { created_at: 'ASC' },
    });
    return rows.map((row) => {
      const gen = row.generation_request_json as {
        script_text?: string;
      } | null;
      const details = row.media_details as { mime_type?: string } | null;
      return {
        id: row.id,
        media_type: row.media_type,
        source: row.source,
        status: row.status,
        created_at: row.created_at,
        state_transition_id: row.state_transition_id,
        text: row.text ?? null,
        has_content: !!row.s3_key,
        content_mime: details?.mime_type ?? null,
        generation_script: gen?.script_text ?? null,
        wa_media_url: row.wa_media_url,
      };
    });
  }

  @Delete(':id')
  async deleteMedia(@Param('id') id: string): Promise<DeleteResponse> {
    await this.mediaMetaDataService.markRolledBack(id);
    return { deleted: true };
  }

  @Get(':id/audio')
  async getAudio(@Param('id') id: string, @Res() res: Response) {
    const media = await this.mediaRepo.findOneBy({ id });
    if (!media || !media.s3_key) {
      throw new NotFoundException('Media not found or no audio available');
    }
    const { buffer, content_type } = await this.mediaBucket.getBuffer(
      media.s3_key,
    );
    res.set('Content-Type', content_type);
    res.set('Content-Length', buffer.length.toString());
    res.send(buffer);
  }

  @Post('heygen-generate')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBody({
    schema: { type: 'object', properties: { items: { type: 'array' } } },
  })
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
  @ApiBody({
    schema: { type: 'object', properties: { items: { type: 'array' } } },
  })
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
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        items: {
          type: 'string',
          description:
            'JSON array of items, e.g. [{"state_transition_id":"x","media_type":"image"}]',
        },
        files: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
          description: 'One file per non-text item, matched in order',
        },
      },
      required: ['items', 'files'],
    },
  })
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
        typeof body.items === 'string' ? JSON.parse(body.items) : body.items;
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
  ): Promise<DashboardTranscriptResponse> {
    if (!body.text?.trim()) throw new BadRequestException('text required');

    const parent = await this.mediaRepo.findOneBy({ id });
    if (!parent) throw new NotFoundException('Media not found');

    const existing = await this.mediaRepo.findOneBy({
      input_media_id: id,
      source: 'dashboard' as any,
      media_type: 'text' as any,
    });
    if (existing)
      throw new BadRequestException('Dashboard transcript already exists');

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
    const saved = await this.mediaRepo.save(entity);
    return {
      id: saved.id,
      text: saved.text,
      source: saved.source,
      input_media_id: saved.input_media_id,
      user_id: saved.user_id,
      created_at: saved.created_at,
    };
  }

  @Patch(':id/dashboard-transcript')
  async updateDashboardTranscript(
    @Param('id') id: string,
    @Body() body: { text: string },
  ): Promise<DashboardTranscriptResponse> {
    if (!body.text?.trim()) throw new BadRequestException('text required');

    const transcript = await this.mediaRepo.findOneBy({
      input_media_id: id,
      source: 'dashboard' as any,
      media_type: 'text' as any,
    });
    if (!transcript)
      throw new NotFoundException('Dashboard transcript not found');

    transcript.text = body.text.trim();
    const saved = await this.mediaRepo.save(transcript);
    return {
      id: saved.id,
      text: saved.text,
      source: saved.source,
      input_media_id: saved.input_media_id,
      user_id: saved.user_id,
      created_at: saved.created_at,
    };
  }

  @Delete(':id/dashboard-transcript')
  async deleteDashboardTranscript(
    @Param('id') id: string,
  ): Promise<DeleteResponse> {
    const transcript = await this.mediaRepo.findOneBy({
      input_media_id: id,
      source: 'dashboard' as any,
      media_type: 'text' as any,
    });
    if (!transcript)
      throw new NotFoundException('Dashboard transcript not found');

    await this.mediaRepo.remove(transcript);
    return { deleted: true };
  }
}
