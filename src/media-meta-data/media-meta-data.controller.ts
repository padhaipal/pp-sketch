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
import { context, trace } from '@opentelemetry/api';
import {
  startRootSpan,
  injectCarrier,
  injectCarrierFromContext,
} from '../otel/otel';

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
      throw new BadRequestException('state_transition_id query param required');
    }
    const rows = await this.mediaRepo.find({
      where: { state_transition_id: stid, rolled_back: false },
      order: { created_at: 'ASC' },
    });
    return rows.map((row) => this.toMediaItemResponse(row));
  }

  private toMediaItemResponse(row: MediaMetaDataEntity): MediaItemResponse {
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
  }

  // Paginated distinct comprehension stids for the dashboard's bottom table
  // (thousands of passages eventually — never unbounded).
  @Get('comprehension-stids')
  async listComprehensionStids(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.mediaMetaDataService.listComprehensionStids({
      limit: limit !== undefined ? parseInt(limit, 10) : undefined,
      offset: offset !== undefined ? parseInt(offset, 10) : undefined,
    });
  }

  // Live passage counts per (level, passage_type, question_type) for the
  // dashboard's seeding counters. Declared before @Get(':id').
  @Get('passage-stats')
  async getPassageStats() {
    return this.mediaMetaDataService.getPassageStats();
  }

  // Paginated passage search (text substring + type filters) for the
  // dashboard. Declared before @Get(':id').
  @Get('passages')
  async searchPassages(
    @Query('q') q?: string,
    @Query('passage_type') passageType?: string,
    @Query('question_type') questionType?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.mediaMetaDataService.searchPassages({
      q,
      passage_type: passageType,
      question_type: questionType,
      limit: limit !== undefined ? parseInt(limit, 10) : undefined,
      offset: offset !== undefined ? parseInt(offset, 10) : undefined,
    });
  }

  // Recent gate-failed generations (soft-deleted question rows carrying
  // media_details.gate_failure) for the dashboard's read-only "Filter
  // failures" list.
  @Get('generation-failures')
  async listGenerationFailures(@Query('limit') limit?: string) {
    return this.mediaMetaDataService.listGenerationFailures({
      limit: limit !== undefined ? parseInt(limit, 10) : undefined,
    });
  }

  // Declared before @Delete(':id') so 'by-state-transition-id' is not
  // captured as an id.
  @Delete('by-state-transition-id')
  async deleteByStateTransitionId(
    @Query('state_transition_id') stid: string,
  ): Promise<{ deleted: number }> {
    if (!stid || typeof stid !== 'string') {
      throw new BadRequestException('state_transition_id query param required');
    }
    return this.mediaMetaDataService.deleteByStateTransitionId(stid);
  }

  // Synchronous seeding endpoint (no queue): LLM generation → validation →
  // passage-judge gate → zero-context solvability filter (narrative
  // R1.1–R1.3 only) → entity tree insert (one passage, one question). Slow
  // by nature: gate calls are paced 2s apart (Sarvam rate limit) — 10 valid
  // judge runs over ≤14 calls, then 24 valid solvability runs over ≤50
  // calls, ~1-2.5 min per gated item; the dashboard sends one generation
  // per request and shows the outcome.
  @Post('llm-generate')
  @HttpCode(HttpStatus.OK)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        provider: { type: 'string' },
        model: { type: 'string' },
        messages: { type: 'array' },
      },
    },
  })
  @ApiResponse({ status: 200 })
  async llmGenerate(@Body() body: unknown) {
    const span = startRootSpan('llm-generate-controller');
    try {
      const ctxWithSpan = trace.setSpan(context.active(), span);
      return await context.with(ctxWithSpan, () =>
        this.mediaMetaDataService.createLlmGeneratedMedia(
          body,
          injectCarrierFromContext(ctxWithSpan),
        ),
      );
    } finally {
      span.end();
    }
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

  // Single media row by id, for the dashboard's read-only views (e.g. the
  // comprehension modal fetching the passage row, which carries no stid —
  // its id is the `…-sentence-comprehension` prefix). Declared after every
  // named @Get so ':id' cannot capture 'coverage' etc.; the uuid guard is a
  // second line of defense against that.
  @Get(':id')
  async getMedia(@Param('id') id: string): Promise<MediaItemResponse> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new BadRequestException('id must be a uuid');
    }
    const row = await this.mediaRepo.findOneBy({ id, rolled_back: false });
    if (!row) {
      throw new NotFoundException('Media not found');
    }
    return this.toMediaItemResponse(row);
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
      // Use injectCarrierFromContext so any W3C Baggage on the active
      // context (e.g. padhaipal.load_test=true propagated from the
      // upstream caller) flows into the job carrier — required for the
      // ElevenLabs/HeyGen processors' load-test stub to actually fire.
      const ctxWithSpan = trace.setSpan(context.active(), span);
      const entities = await this.mediaMetaDataService.createHeygenMedia(
        validated,
        injectCarrierFromContext(ctxWithSpan),
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
      const ctxWithSpan = trace.setSpan(context.active(), span);
      const entities = await this.mediaMetaDataService.createElevenlabsMedia(
        validated,
        injectCarrierFromContext(ctxWithSpan),
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
      source: 'dashboard',
      media_type: 'text',
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
      source: 'dashboard',
      media_type: 'text',
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
      source: 'dashboard',
      media_type: 'text',
    });
    if (!transcript)
      throw new NotFoundException('Dashboard transcript not found');

    await this.mediaRepo.remove(transcript);
    return { deleted: true };
  }
}
