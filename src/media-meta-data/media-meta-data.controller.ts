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

    // Validate files
    if (!files || files.length === 0 || files.length !== validatedItems.length) {
      throw new BadRequestException(
        'files must be a non-empty array with length matching items',
      );
    }
    for (let i = 0; i < files.length; i++) {
      assertValidStaticMediaFile(files[i], i);
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
