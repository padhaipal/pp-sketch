import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiConsumes, ApiResponse, ApiBody } from '@nestjs/swagger';
import { MediaMetaDataService } from './media-meta-data.service';
import {
  validateCreateHeygenMediaOptions,
  validateCreateElevenlabsMediaOptions,
  validateUploadStaticMediaItems,
  assertValidStaticMediaFile,
} from './media-meta-data.dto';
import { startRootSpan, injectCarrier } from '../otel/otel';

@ApiTags('media-meta-data')
@Controller('media-meta-data')
export class MediaMetaDataController {
  constructor(
    private readonly mediaMetaDataService: MediaMetaDataService,
  ) {}

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
}
