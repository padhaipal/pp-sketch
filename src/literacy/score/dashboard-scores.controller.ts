import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { validateGeoEntityId } from '../../geo-entities/geo-entity.dto';
import { DashboardScoresService } from './dashboard-scores.service';
import {
  PUBLIC_CACHE_CONTROL,
  ScoresResponse,
  SpotlightResponse,
  toCsv,
  validateMetric,
  validateRange,
} from './dashboard-scores.dto';

// Public, unauthenticated reads for the teacher dashboard (/d/:id). These
// three paths are on the pp-dashboard proxy's PUBLIC_ALLOWED list. Cached
// for five minutes: the data changes once a night and these are the
// heaviest queries in the app.
@Controller('geo-entities')
export class DashboardScoresController {
  constructor(private readonly scores: DashboardScoresService) {}

  @Get(':id/scores')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  async getScores(
    @Param('id') id: string,
    @Query('metric') metric?: string,
    @Query('range') range?: string,
  ): Promise<ScoresResponse> {
    return this.scores.scores(
      validateGeoEntityId(id),
      validateMetric(metric),
      validateRange(range),
    );
  }

  @Get(':id/scores.csv')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async getScoresCsv(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
    @Query('metric') metric?: string,
    @Query('range') range?: string,
  ): Promise<string> {
    const result = await this.scores.scores(
      validateGeoEntityId(id),
      validateMetric(metric),
      validateRange(range),
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="lifteracy-${result.entity.type}-${result.entity.code}-${result.metric}-${result.range}d.csv"`,
    );
    return toCsv(result.children as unknown as Array<Record<string, unknown>>);
  }

  @Get(':id/spotlight')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  async getSpotlight(
    @Param('id') id: string,
    @Query('metric') metric?: string,
    @Query('range') range?: string,
  ): Promise<SpotlightResponse> {
    return this.scores.spotlight(
      validateGeoEntityId(id),
      validateMetric(metric),
      validateRange(range),
    );
  }
}
