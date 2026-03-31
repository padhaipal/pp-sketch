import {
  Controller,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LetterService } from './letter.service';
import {
  validateCreateLetterOptions,
  validateCreateBulkLetterOptions,
  validateUpdateLetterOptions,
} from './letter.dto';
import { startRootSpan } from '../../otel/otel';

@ApiTags('letters')
@Controller('letters')
export class LetterController {
  constructor(private readonly letterService: LetterService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createLetter(@Body() body: unknown) {
    const validated = validateCreateLetterOptions(body);
    const span = startRootSpan('create-letter-controller');
    try {
      const letter = await this.letterService.create(validated);
      return letter;
    } finally {
      span.end();
    }
  }

  @Post('bulk')
  @HttpCode(HttpStatus.CREATED)
  async createLettersBulk(@Body() body: unknown) {
    const validated = validateCreateBulkLetterOptions(body);
    const span = startRootSpan('create-letters-bulk-controller');
    try {
      const letters = await this.letterService.createBulk(validated);
      return letters;
    } finally {
      span.end();
    }
  }

  @Patch(':grapheme')
  async updateLetter(
    @Param('grapheme') grapheme: string,
    @Body() body: Record<string, unknown>,
  ) {
    const validated = validateUpdateLetterOptions({
      ...body,
      grapheme,
    });
    const span = startRootSpan('update-letter-controller');
    try {
      const letter = await this.letterService.update(validated);
      if (!letter) {
        throw new NotFoundException('Letter not found');
      }
      return letter;
    } finally {
      span.end();
    }
  }

  @Delete(':grapheme')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteLetter(@Param('grapheme') grapheme: string) {
    const span = startRootSpan('delete-letter-controller');
    try {
      const deleted = await this.letterService.delete({ grapheme });
      if (!deleted) {
        throw new NotFoundException('Letter not found');
      }
    } catch (err) {
      if (err instanceof BadRequestException) {
        throw new ConflictException((err as BadRequestException).message);
      }
      throw err;
    } finally {
      span.end();
    }
  }
}
