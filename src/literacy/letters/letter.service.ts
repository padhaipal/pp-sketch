import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LetterEntity } from './letter.entity';
import {
  Letter,
  CreateLetterOptions,
  CreateBulkLetterOptions,
  UpdateLetterOptions,
  DeleteLetterOptions,
  validateCreateLetterOptions,
  validateCreateBulkLetterOptions,
  validateUpdateLetterOptions,
  validateDeleteLetterOptions,
} from './letter.dto';

@Injectable()
export class LetterService {
  constructor(
    @InjectRepository(LetterEntity)
    private readonly letterRepo: Repository<LetterEntity>,
  ) {}

  async create(options: CreateLetterOptions): Promise<Letter> {
    const validated = validateCreateLetterOptions(options);

    try {
      const entity = this.letterRepo.create({
        grapheme: validated.grapheme,
        media_metadata_id: validated.media_metadata_id ?? null,
      });
      return await this.letterRepo.save(entity);
    } catch (err: any) {
      if (err.code === '23505') {
        throw new BadRequestException(
          'create() grapheme already exists',
        );
      }
      throw err;
    }
  }

  async createBulk(options: CreateBulkLetterOptions): Promise<Letter[]> {
    const validated = validateCreateBulkLetterOptions(options);

    const entities = validated.items.map((item) =>
      this.letterRepo.create({
        grapheme: item.grapheme,
        media_metadata_id: item.media_metadata_id ?? null,
      }),
    );

    try {
      return await this.letterRepo.save(entities);
    } catch (err: any) {
      if (err.code === '23505') {
        throw new BadRequestException(
          'createBulk() one or more graphemes already exist',
        );
      }
      throw err;
    }
  }

  async update(options: UpdateLetterOptions): Promise<Letter | null> {
    const validated = validateUpdateLetterOptions(options);

    const existing = await this.letterRepo.findOneBy({
      grapheme: validated.grapheme,
    });
    if (!existing) return null;

    if (validated.new_grapheme !== undefined) {
      existing.grapheme = validated.new_grapheme;
    }
    if (validated.new_media_metadata_id !== undefined) {
      existing.media_metadata_id = validated.new_media_metadata_id;
    }

    try {
      return await this.letterRepo.save(existing);
    } catch (err: any) {
      if (err.code === '23505') {
        throw new BadRequestException(
          'update() new_grapheme already exists',
        );
      }
      throw err;
    }
  }

  async delete(options: DeleteLetterOptions): Promise<boolean> {
    const validated = validateDeleteLetterOptions(options);

    try {
      const result = await this.letterRepo.delete({
        grapheme: validated.grapheme,
      });
      return (result.affected ?? 0) > 0;
    } catch (err: any) {
      if (err.code === '23503') {
        throw new BadRequestException(
          'delete() letter is referenced by existing scores — remove scores first',
        );
      }
      throw err;
    }
  }
}
