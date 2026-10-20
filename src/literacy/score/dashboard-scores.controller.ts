import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { validateGeoEntityId } from '../../geo-entities/geo-entity.dto';
import { DashboardScoresService } from './dashboard-scores.service';
import {
  ShareMessageService,
  type ShareMessageResponse,
} from './share-message.service';
import { ANONYMOUS, Viewer, type ViewerContext } from '../../auth/viewer';
import {
  PUBLIC_CACHE_CONTROL,
  ScoresResponse,
  RankingsResponse,
  SpotlightResponse,
  ChildRow,
  flattenVerdictRows,
  toCsv,
  VERDICT_METRIC,
  validateRankLevel,
  validateMetric,
  validateRange,
  validateWindow,
} from './dashboard-scores.dto';

// Reads for the teacher dashboard (/d/:id). These three paths are on the
// pp-dashboard proxy's PUBLIC_ALLOWED list, so no session is needed — the
// proxy forwards who is looking (auth/viewer.ts) and the service masks
// names / phones accordingly. Cached for five minutes: the data changes
// once a night and these are the heaviest queries in the app.
@Controller('geo-entities')
export class DashboardScoresController {
  constructor(
    private readonly scores: DashboardScoresService,
    private readonly shareMessage: ShareMessageService,
  ) {}

  // The viewer's own unit only (a teacher's class, an official's geo
  // entity): a fresh Hindi WhatsApp message written by an LLM from the
  // unit's numbers (share-message.service.ts). Never cached, never stored.
  @Get(':id/share-message')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  async getShareMessage(
    @Param('id') id: string,
    @Viewer() viewer: ViewerContext = ANONYMOUS,
  ): Promise<ShareMessageResponse> {
    return this.shareMessage.generate(validateGeoEntityId(id), viewer);
  }

  @Get(':id/scores')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  async getScores(
    @Param('id') id: string,
    @Query('metric') metric?: string,
    @Query('range') range?: string,
    // usage ("Time") only: yesterday | 7d | all — see TIME_WINDOWS.
    @Query('window') window?: string,
    @Viewer() viewer: ViewerContext = ANONYMOUS,
  ): Promise<ScoresResponse> {
    return this.scores.scores(
      validateGeoEntityId(id),
      validateMetric(metric),
      validateRange(range),
      validateWindow(window),
      viewer,
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
    @Query('window') window?: string,
    @Viewer() viewer: ViewerContext = ANONYMOUS,
  ): Promise<string> {
    const result = await this.scores.scores(
      validateGeoEntityId(id),
      validateMetric(metric),
      validateRange(range),
      validateWindow(window),
      viewer,
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="lifteracy-${result.entity.type}-${result.entity.code}-${result.metric}-${result.window ? `time-${result.window}` : result.range === 'all' ? 'all-time' : `${result.range}d`}.csv"`,
    );
    return toCsv(
      result.metric === VERDICT_METRIC
        ? flattenVerdictRows(result.children as ChildRow[])
        : (result.children as unknown as Array<Record<string, unknown>>),
    );
  }

  // Most improved / top performing at any level below `:id` (the dashboard's
  // level toggle above the rankings). Teachers come with their name and
  // number, students with their name only — masked per viewer like scores.
  @Get(':id/rankings')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  async getRankings(
    @Param('id') id: string,
    @Query('level') level?: string,
    @Query('metric') metric?: string,
    @Query('window') window?: string,
    @Viewer() viewer: ViewerContext = ANONYMOUS,
  ): Promise<RankingsResponse> {
    return this.scores.rankings(
      validateGeoEntityId(id),
      validateRankLevel(level),
      validateMetric(metric),
      validateWindow(window),
      viewer,
    );
  }

  @Get(':id/spotlight')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  async getSpotlight(
    @Param('id') id: string,
    @Query('metric') metric?: string,
    @Query('range') range?: string,
    @Query('window') window?: string,
    @Viewer() viewer: ViewerContext = ANONYMOUS,
  ): Promise<SpotlightResponse> {
    return this.scores.spotlight(
      validateGeoEntityId(id),
      validateMetric(metric),
      validateRange(range),
      validateWindow(window),
      viewer,
    );
  }
}
