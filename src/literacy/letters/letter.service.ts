import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
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
  private readonly logger = new Logger(LetterService.name);

  constructor(private readonly dataSource: DataSource) {}

  async create(options: CreateLetterOptions): Promise<Letter> {
    const validated = validateCreateLetterOptions(options);

    try {
      const rows = await this.dataSource.query(
        `INSERT INTO letters (grapheme, media_metadata_id)
         VALUES ($1, $2) RETURNING *`,
        [validated.grapheme, validated.media_metadata_id ?? null],
      );
      return rows[0];
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

    const values: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const item of validated.items) {
      values.push(`($${idx++}, $${idx++})`);
      params.push(item.grapheme, item.media_metadata_id ?? null);
    }

    try {
      const rows = await this.dataSource.query(
        `INSERT INTO letters (grapheme, media_metadata_id)
         VALUES ${values.join(', ')} RETURNING *`,
        params,
      );
      return rows;
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

    const setClauses: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (validated.new_grapheme !== undefined) {
      setClauses.push(`grapheme = $${idx++}`);
      params.push(validated.new_grapheme);
    }
    if (validated.new_media_metadata_id !== undefined) {
      setClauses.push(`media_metadata_id = $${idx++}`);
      params.push(validated.new_media_metadata_id);
    }

    params.push(validated.grapheme);

    try {
      const rows = await this.dataSource.query(
        `UPDATE letters SET ${setClauses.join(', ')}
         WHERE grapheme = $${idx} RETURNING *`,
        params,
      );
      return rows[0] ?? null;
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
      const rows = await this.dataSource.query(
        'DELETE FROM letters WHERE grapheme = $1 RETURNING id',
        [validated.grapheme],
      );
      return rows.length > 0;
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
