import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GeoEntityService } from './geo-entity.service';
import {
  DescendantsPage,
  GeoEntity,
  GeoEntitySearchRow,
  GeoEntityType,
  validateDescendantsLimit,
  validateGeoEntityId,
  validateGeoEntityType,
} from './geo-entity.dto';

// Read-only; reached only through the pp-dashboard proxy (admin/dev).
@ApiTags('geo-entities')
@Controller('geo-entities')
export class GeoEntityController {
  constructor(private readonly geoEntityService: GeoEntityService) {}

  @Get('search')
  async search(
    @Query('q') q?: string,
    @Query('type') type?: string,
  ): Promise<GeoEntitySearchRow[]> {
    const validatedType: GeoEntityType | null =
      type === undefined || type === '' ? null : validateGeoEntityType(type);
    return this.geoEntityService.search(q ?? '', validatedType);
  }

  @Get(':id')
  async getOne(
    @Param('id') id: string,
  ): Promise<GeoEntity & { ancestors: GeoEntity[] }> {
    const validId = validateGeoEntityId(id);
    const entity = await this.geoEntityService.getById(validId);
    if (!entity) throw new NotFoundException('Geo entity not found');
    const ancestors = await this.geoEntityService.ancestors(validId);
    return { ...entity, ancestors };
  }

  @Get(':id/descendants')
  async descendants(
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<DescendantsPage> {
    const validId = validateGeoEntityId(id);
    const validatedType = validateGeoEntityType(type);
    const validatedCursor =
      cursor === undefined || cursor === ''
        ? null
        : validateGeoEntityId(cursor, 'cursor');
    const validatedLimit = validateDescendantsLimit(limit);
    const entity = await this.geoEntityService.getById(validId);
    if (!entity) throw new NotFoundException('Geo entity not found');
    return this.geoEntityService.descendants(validId, validatedType, {
      cursor: validatedCursor,
      limit: validatedLimit,
    });
  }
}
