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
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { once } from 'events';
import * as bcrypt from 'bcrypt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from './user.entity';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import { ScoreEntity } from '../literacy/score/score.entity';
import { LiteracyLessonStateEntity } from '../literacy/literacy-lesson/literacy-lesson-state.entity';
import { toLogId } from '../otel/pii';
import {
  LoginDto,
  PatchUserDto,
  DashboardSummaryResponse,
  DashboardUserRow,
  UserMediaResponse,
  ScoreRow,
  LoginResponse,
  UserResponse,
  ActivityTimeRequestDto,
  ActivityTimeResponse,
  UserMetrics,
  StaffCreateDto,
  StaffCreateResponse,
  StaffUserDetail,
  StaffUserRow,
  UpdateUserOptions,
  PROTECTED_ROLES,
  normaliseStaffPhone,
} from './user.dto';
import { UserActivityService } from './user-activity.service';
import { UserService, StaffLookupRow } from './user.service';
import { GeoEntityService } from '../geo-entities/geo-entity.service';
import { DEFAULT_ROLE_TITLE_BY_TYPE } from '../geo-entities/geo-entity.dto';
import { staffDashboardLink } from '../interfaces/dashboard/dashboard-url';
import {
  INTERACTIONS_BATCH_SIZE,
  interactionRowToCsvLine,
  interactionsCsvFooterLine,
  interactionsCsvHeaderLine,
} from './interactions-csv';
import {
  addDays,
  istDateIso,
  istMidnightUtc,
} from '../notifier/report-card/report-card.utils';

function withLink(row: StaffLookupRow): StaffUserRow {
  return { ...row, link: staffDashboardLink(row.id) };
}

@ApiTags('users')
@Controller('users')
export class UserController {
  private readonly logger = new Logger(UserController.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    @InjectRepository(MediaMetaDataEntity)
    private readonly mediaRepo: Repository<MediaMetaDataEntity>,
    @InjectRepository(ScoreEntity)
    private readonly scoreRepo: Repository<ScoreEntity>,
    @InjectRepository(LiteracyLessonStateEntity)
    private readonly lessonStateRepo: Repository<LiteracyLessonStateEntity>,
    private readonly userActivityService: UserActivityService,
    private readonly userService: UserService,
    private readonly geoEntityService: GeoEntityService,
  ) {}

  // ─── Staff accounts (education officials) ─────────────────────────────
  // Declared before the ':id/…' routes only for readability — Nest matches
  // by segment count, but 'lookup' and ':id' below MUST come after
  // 'dashboard', 'dashboard/summary' and 'interactions.csv' (see their
  // placement) or a literal path is captured as an id.

  @Post('staff-create')
  @HttpCode(HttpStatus.CREATED)
  async staffCreate(
    @Body() body: StaffCreateDto,
  ): Promise<StaffCreateResponse> {
    const external_id = normaliseStaffPhone(body.external_id);
    const geo = await this.geoEntityService.getById(body.geo_entity_id);
    if (!geo || geo.status !== 'operational' || geo.deleted_at !== null) {
      throw new UnprocessableEntityException(
        'geo_entity_id must reference an operational, non-deleted geo entity',
      );
    }
    const role_title =
      body.role_title?.trim() ||
      DEFAULT_ROLE_TITLE_BY_TYPE[geo.type] ||
      'Staff';
    const user = await this.userService.createStaff({
      name: body.name.trim(),
      external_id,
      geo_entity_id: geo.id,
      role_title,
      staff_notes: body.staff_notes?.trim() || null,
    });
    const row = withLink({
      id: user.id,
      external_id: user.external_id,
      name: user.name,
      role: user.role ?? 'education_official',
      role_title: user.role_title,
      staff_notes: user.staff_notes,
      geo_entity_id: geo.id,
      geo_entity_name: geo.name,
      geo_entity_type: geo.type,
      deleted_at: user.deleted_at,
    });
    this.logger.log(
      `staff-create: ${toLogId(external_id)} → ${user.id} (${geo.type} ${geo.code})`,
    );
    return { user: row, link: row.link };
  }

  @Post('activity-time')
  async activityTime(
    @Body() body: ActivityTimeRequestDto,
  ): Promise<ActivityTimeResponse> {
    return this.userActivityService.getActivityTime(body);
  }

  // Declared before the ':id/*' routes so 'dashboard' is never captured as an
  // id. Cached inside the service — see getDashboardSummary.
  // Full student-interaction export, streamed as CSV (dev-role only — the
  // dashboard proxy's admin allowlist does not include this path). Keyset
  // batches keep memory constant; rows are oldest-first so a cut-off
  // download is still a valid file, and the trailing "# export complete"
  // marker distinguishes complete from truncated (resume = re-run with
  // from = the last row's timestamp).
  @Get('interactions.csv')
  async interactionsCsv(
    @Res() res: Response,
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
  ): Promise<void> {
    const parse = (label: string, v?: string): Date | null => {
      if (v === undefined || v === '') return null;
      const d = new Date(v);
      if (isNaN(d.getTime())) {
        throw new BadRequestException(`${label} must be an ISO date`);
      }
      return d;
    };
    const from = parse('from', fromRaw);
    const requestedTo = parse('to', toRaw);
    // Pin the upper bound at request start so rows written mid-stream can
    // never shift the keyset ordering under us.
    const now = new Date();
    const to = requestedTo === null || requestedTo > now ? now : requestedTo;
    if (from !== null && from > to) {
      throw new BadRequestException('from must not be after to');
    }

    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="interactions.csv"');

    const write = async (chunk: string): Promise<void> => {
      if (!res.write(chunk)) await once(res, 'drain');
    };

    await write(interactionsCsvHeaderLine());
    let cursor: { created_at: Date; id: string } | null = null;
    let total = 0;
    for (;;) {
      const rows = await this.userService.findInteractionsPage({
        from,
        to,
        cursor,
        limit: INTERACTIONS_BATCH_SIZE,
      });
      for (const row of rows) {
        await write(interactionRowToCsvLine(row));
      }
      total += rows.length;
      if (rows.length < INTERACTIONS_BATCH_SIZE) break;
      const last = rows[rows.length - 1];
      cursor = { created_at: last.created_at, id: last.lesson_state_id };
    }
    await write(interactionsCsvFooterLine(total));
    res.end();
    this.logger.log(
      `interactions.csv: streamed ${total} rows (from=${fromRaw ?? 'all'}, to=${to.toISOString()})`,
    );
  }

  @Get('dashboard/summary')
  async dashboardSummary(): Promise<DashboardSummaryResponse> {
    return this.userActivityService.getDashboardSummary();
  }

  @Get('dashboard')
  async dashboard(
    @Query('offset') offsetStr?: string,
    @Query('referrer') referrer?: string,
  ): Promise<DashboardUserRow[]> {
    const offset = Math.max(0, parseInt(offsetStr || '0', 10) || 0);
    const limit = 100;

    // Find 100 most recently active user IDs. When `referrer` is given, the
    // filter is applied HERE — before offset/limit — so pagination walks the
    // filtered set. Matches referrer name or phone as a case-insensitive
    // substring (mirrors what the Referred-by column displays); the inner
    // joins implicitly drop users with no referrer.
    const activeQb = this.mediaRepo
      .createQueryBuilder('mm')
      .select('mm.user_id', 'user_id')
      .addSelect('MAX(mm.created_at)', 'last_active')
      .where('mm.user_id IS NOT NULL');

    const referrerTerm = referrer?.trim();
    if (referrerTerm) {
      activeQb
        .innerJoin('users', 'u', 'u.id = mm.user_id')
        .innerJoin('users', 'ref', 'ref.id = u.referrer_user_id')
        .andWhere('(ref.name ILIKE :q OR ref.external_id ILIKE :q)', {
          q: `%${referrerTerm}%`,
        });
    }

    const activeUsers = await activeQb
      .groupBy('mm.user_id')
      .orderBy('last_active', 'DESC')
      .offset(offset)
      .limit(limit)
      .getRawMany<{ user_id: string; last_active: Date }>();

    if (activeUsers.length === 0) return [];

    const userIds = activeUsers.map((r) => r.user_id);

    // Fetch user details
    const users = await this.userRepo
      .createQueryBuilder('u')
      .select(['u.id', 'u.name', 'u.external_id', 'u.referrer_user_id'])
      .whereInIds(userIds)
      .getMany();

    const userMap = new Map(users.map((u) => [u.id, u]));

    // Fetch referrer details for users that have a referrer
    const referrerIds = Array.from(
      new Set(
        users.map((u) => u.referrer_user_id).filter((id): id is string => !!id),
      ),
    );
    const referrers =
      referrerIds.length > 0
        ? await this.userRepo
            .createQueryBuilder('u')
            .select(['u.id', 'u.name', 'u.external_id'])
            .whereInIds(referrerIds)
            .getMany()
        : [];
    const referrerMap = new Map(referrers.map((r) => [r.id, r]));

    // 7 IST-day windows ending today (inclusive). Day i covers
    // [todayMid - (6-i)*24h, todayMid - (6-i)*24h + 24h). Today's window
    // extends past "now" — getActivityTime only counts events that have
    // happened, so today reads as partial.
    const todayMidIst = istMidnightUtc(new Date());
    const startMidIst = addDays(todayMidIst, -6);
    const windows = Array.from({ length: 7 }, (_, i) => {
      const start = addDays(startMidIst, i);
      const end = addDays(start, 1);
      return { start: start.toISOString(), end: end.toISOString() };
    });

    const activity = await this.userActivityService.getActivityTime({
      users: userIds,
      windows,
    });

    const activityByUser = new Map<string, number[]>(
      activity.results.map((r) => [
        r.user_id,
        r.windows.map((w) => w.active_ms),
      ]),
    );

    const dates = windows.map((_, i) => istDateIso(addDays(startMidIst, i)));

    return activeUsers.map((r) => {
      const user = userMap.get(r.user_id);
      const userActivity = activityByUser.get(r.user_id);
      const refId = user?.referrer_user_id ?? null;
      const refUser = refId ? referrerMap.get(refId) : undefined;
      return {
        id: r.user_id,
        name: user?.name ?? null,
        external_id: user?.external_id ?? '',
        referrer: refUser
          ? { name: refUser.name, external_id: refUser.external_id }
          : null,
        activity: dates.map((date, i) => ({
          date,
          active_ms: userActivity?.[i] ?? 0,
        })),
      };
    });
  }

  // Digital-proxy literacy test scores (NIPUN grades 2-3 + MPL-B): latest
  // snapshot score + score-over-time history per test, or
  // 'insufficient_data' while there is not enough answer history yet.
  @Get(':id/literacy-test-scores')
  async literacyTestScores(@Param('id') id: string) {
    const scores = await this.userService.getLiteracyTestScores(id);
    if (!scores) throw new NotFoundException('User not found');
    return scores;
  }

  @Get(':id/metrics')
  async userMetrics(@Param('id') id: string): Promise<UserMetrics> {
    const FIVE_MIN_MS = 5 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;

    const user = await this.userRepo.findOneBy({ id });
    if (!user) throw new NotFoundException('User not found');

    // One IST-day window per day from the signup day through today, inclusive.
    // Today's window extends past "now" — getActivityTime only counts events
    // that have happened, so today reads as partial. getActivityTime fetches
    // the underlying audio once over the whole span, so window count is cheap.
    const signupMidIst = istMidnightUtc(user.created_at);
    const todayMidIst = istMidnightUtc(new Date());
    const daysSinceSignup = Math.round(
      (todayMidIst.getTime() - signupMidIst.getTime()) / DAY_MS,
    );
    const windows = Array.from({ length: daysSinceSignup + 1 }, (_, i) => {
      const start = addDays(signupMidIst, i);
      const end = addDays(start, 1);
      return { start: start.toISOString(), end: end.toISOString() };
    });

    const activity = await this.userActivityService.getActivityTime({
      users: [id],
      windows,
    });

    const dayMs = activity.results[0]?.windows.map((w) => w.active_ms) ?? [];

    return {
      days_since_signup: daysSinceSignup,
      total_active_ms: dayMs.reduce((sum, ms) => sum + ms, 0),
      days_over_five_min: dayMs.filter((ms) => ms > FIVE_MIN_MS).length,
    };
  }

  @Get(':id/media')
  async userMedia(
    @Param('id') id: string,
    @Query('offset') offsetStr?: string,
  ): Promise<UserMediaResponse> {
    const offset = Math.max(0, parseInt(offsetStr || '0', 10) || 0);
    const limit = 100;

    // Fetch user details
    const user = await this.userRepo.findOneBy({ id });
    if (!user) throw new NotFoundException('User not found');

    // 100 most recent whatsapp audio for this user
    const media = await this.mediaRepo.find({
      where: {
        user_id: id,
        source: 'whatsapp',
        media_type: 'audio',
      },
      order: { created_at: 'DESC' },
      skip: offset,
      take: limit,
    });

    if (media.length === 0) {
      return { user: { name: user.name, phone: user.external_id }, media: [] };
    }

    const mediaIds = media.map((m) => m.id);

    // Find all transcripts where input_media_id is one of these media IDs
    const transcripts = await this.mediaRepo
      .createQueryBuilder('mm')
      .select([
        'mm.id',
        'mm.input_media_id',
        'mm.text',
        'mm.source',
        'mm.created_at',
      ])
      .where('mm.input_media_id IN (:...mediaIds)', { mediaIds })
      .getMany();

    // Group transcripts by input_media_id
    const transcriptMap = new Map<
      string,
      { text: string | null; source: string; created_at: Date }[]
    >();
    for (const t of transcripts) {
      if (!t.input_media_id) continue;
      if (!transcriptMap.has(t.input_media_id))
        transcriptMap.set(t.input_media_id, []);
      transcriptMap
        .get(t.input_media_id)!
        .push({ text: t.text, source: t.source, created_at: t.created_at });
    }

    // Find lesson states where user_message_id matches any of these media IDs.
    // Order by created_at ASC so the evaluation row (first insert) comes before
    // the "start fresh" row when a word is completed and a new lesson begins in
    // the same processAnswer cycle (both share the same user_message_id).
    const lessonStates = await this.lessonStateRepo
      .createQueryBuilder('ls')
      .select([
        'ls.user_message_id',
        'ls.word',
        'ls.answer',
        'ls.answer_correct',
        'ls.snapshot',
        'ls.level',
      ])
      .where('ls.user_message_id IN (:...mediaIds)', { mediaIds })
      .orderBy('ls.created_at', 'ASC')
      .getMany();

    // Keep the first (evaluation) row per user_message_id; skip the "start fresh" duplicate.
    const lessonMap = new Map<
      string,
      {
        word: string;
        answer: string | null;
        answer_correct: boolean | null;
        starting_state: string | null;
        final_state: string | null;
        level: number | null;
      }
    >();
    for (const ls of lessonStates) {
      if (lessonMap.has(ls.user_message_id)) continue;
      const snapshotContext = (
        ls.snapshot as { context?: { stateTransitionId?: string } }
      ).context;
      const transitionId = snapshotContext?.stateTransitionId;
      let startingState: string | null = null;
      let finalState: string | null = null;
      if (transitionId) {
        const parts = transitionId.split('-');
        if (parts.length >= 3) {
          startingState = parts[1];
          finalState = parts[2];
        }
      }
      lessonMap.set(ls.user_message_id, {
        // Passage lessons may have a null word column; the map renders text.
        word: ls.word ?? '',
        answer: ls.answer,
        answer_correct: ls.answer_correct,
        starting_state: startingState,
        final_state: finalState,
        level: ls.level,
      });
    }

    // Fetch score changes with previous values via window function
    const scoreChangeRows: {
      user_message_id: string;
      grapheme: string;
      score: number;
      prev_score: number | null;
    }[] = await this.scoreRepo.manager.query(
      `WITH windowed AS (
          SELECT s.user_message_id, s.score, l.grapheme,
                 LAG(s.score) OVER (PARTITION BY s.letter_id ORDER BY s.created_at) AS prev_score
          FROM scores s
          JOIN letters l ON l.id = s.letter_id
          WHERE s.user_id = $1
        )
        SELECT user_message_id, grapheme, score, prev_score
        FROM windowed
        WHERE user_message_id = ANY($2)
        ORDER BY user_message_id, grapheme`,
      [id, mediaIds],
    );

    const scoreChangeMap = new Map<
      string,
      { grapheme: string; score: number; prev_score: number | null }[]
    >();
    for (const row of scoreChangeRows) {
      if (!scoreChangeMap.has(row.user_message_id))
        scoreChangeMap.set(row.user_message_id, []);
      scoreChangeMap.get(row.user_message_id)!.push({
        grapheme: row.grapheme,
        score: Number(row.score),
        prev_score: row.prev_score !== null ? Number(row.prev_score) : null,
      });
    }

    // The DB answer column holds the correct answer for the NEXT state (after
    // entry actions run), not for the state the user just answered in. To display
    // the correct answer the user was asked, we offset by one: each row's
    // displayed answer is the chronologically previous lesson state's answer.
    // When a new word starts (or for the first row), use lesson.word instead.
    // Media is ordered created_at DESC, so iterate in reverse for chronological order.
    const displayedAnswerMap = new Map<string, string | null>();
    let prevAnswer: string | null = null;
    let prevWord: string | null = null;
    for (let i = media.length - 1; i >= 0; i--) {
      const lesson = lessonMap.get(media[i].id);
      if (!lesson) {
        displayedAnswerMap.set(media[i].id, null);
        continue;
      }
      if (prevWord === null || lesson.word !== prevWord) {
        displayedAnswerMap.set(media[i].id, lesson.word);
      } else {
        displayedAnswerMap.set(media[i].id, prevAnswer);
      }
      prevAnswer = lesson.answer;
      prevWord = lesson.word;
    }

    return {
      user: { name: user.name, phone: user.external_id },
      media: media.map((m) => {
        const lesson = lessonMap.get(m.id);
        // Reading speed for passage-read turns only: the lesson row's word
        // column stores the joined sentence there (>= 2 tokens; drill turns
        // store a single word), and duration_ms is the container-parsed
        // voice-note length captured at ingest (audio-duration.utils.ts).
        const words = (lesson?.word ?? '').split(/\s+/).filter(Boolean).length;
        const durationMs = (m.media_details as { duration_ms?: number } | null)
          ?.duration_ms;
        const wpm =
          words >= 2 && typeof durationMs === 'number' && durationMs > 0
            ? Math.round(words / (durationMs / 60_000))
            : null;
        return {
          id: m.id,
          created_at: m.created_at,
          has_audio: !!m.s3_key,
          transcripts: transcriptMap.get(m.id) ?? [],
          word: lesson?.word ?? null,
          starting_state: lesson?.starting_state ?? null,
          answer: displayedAnswerMap.get(m.id) ?? null,
          answer_correct: lesson?.answer_correct ?? null,
          score_changes: scoreChangeMap.get(m.id) ?? [],
          final_state: lesson?.final_state ?? null,
          level: lesson?.level ?? null,
          wpm,
        };
      }),
    };
  }

  @Get(':id/scores')
  async userScores(@Param('id') id: string): Promise<ScoreRow[]> {
    const rows: {
      score: number;
      created_at: Date;
      letter_id: string;
      grapheme: string;
      user_message_id: string | null;
    }[] = await this.scoreRepo.manager.query(
      `SELECT s.score, s.created_at, s.letter_id, s.user_message_id, l.grapheme
       FROM scores s
       JOIN letters l ON l.id = s.letter_id
       WHERE s.user_id = $1
       ORDER BY s.created_at ASC`,
      [id],
    );

    return rows.map((r) => ({
      score: Number(r.score),
      created_at: r.created_at,
      letter_id: r.letter_id,
      grapheme: r.grapheme,
      is_seed: r.user_message_id === null,
      user_message_id: r.user_message_id,
    }));
  }

  // After 'dashboard' / 'dashboard/summary' / 'interactions.csv' (literal
  // single-segment routes) and before ':id' — Nest matches in declaration
  // order, so the other way round 'lookup' would be captured as an id.
  @Get('lookup')
  async lookup(@Query('q') q?: string): Promise<StaffUserRow[]> {
    const rows = await this.userService.lookupStaff(q ?? '');
    return rows.map(withLink);
  }

  @Get(':id')
  async getStaff(@Param('id') id: string): Promise<StaffUserDetail> {
    const row = await this.userService.getStaff(id);
    // Non-staff roles (dev/admin/student) and unknown ids are the same 404:
    // this endpoint exists for the /onboarding page only.
    if (!row) throw new NotFoundException('User not found');
    const geo_entity = row.geo_entity_id
      ? await this.geoEntityService.getById(row.geo_entity_id)
      : null;
    const ancestors = geo_entity
      ? await this.geoEntityService.ancestors(geo_entity.id)
      : [];
    return { ...withLink(row), geo_entity, ancestors };
  }

  @Post('login')
  async login(@Body() body: LoginDto): Promise<LoginResponse> {
    const { phone, password } = body;

    if (!phone || !password) {
      this.logger.warn(
        `Login missing fields phone=${!!phone} password=${!!password}`,
      );
      throw new BadRequestException('phone and password required');
    }

    const user = await this.userRepo.findOneBy({ external_id: phone });
    if (!user || !user.password_hash || !user.role) {
      this.logger.warn(
        `Login failed: user not found or missing hash/role phone=${toLogId(phone)}`,
      );
      throw new UnauthorizedException('Invalid credentials');
    }
    // Soft-deleted (deactivated) accounts keep their hash but must not log in.
    if (user.deleted_at) {
      this.logger.warn(
        `Login failed: account deactivated phone=${toLogId(phone)}`,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      this.logger.warn(
        `Login failed: password mismatch phone=${toLogId(phone)}`,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.log(`Login success phone=${toLogId(phone)} id=${user.id}`);
    return { id: user.id, external_id: user.external_id, role: user.role };
  }

  // Goes through UserService.update so the user cache is evicted (the
  // previous userRepo.save path left a renamed student stale for
  // CACHE_TTL.USER). The staff fields are refused on dev/admin targets; name,
  // phone, password and role still work there — that is how admin accounts
  // are managed.
  @Patch(':id')
  async patchUser(
    @Param('id') id: string,
    @Body() body: PatchUserDto,
  ): Promise<UserResponse> {
    const staffFieldsPresent =
      body.new_geo_entity_id !== undefined ||
      body.new_role_title !== undefined ||
      body.new_staff_notes !== undefined ||
      body.deactivate === true ||
      body.reactivate === true;
    if (
      !body.phone &&
      !body.name &&
      !body.password &&
      !body.role &&
      !staffFieldsPresent
    ) {
      throw new BadRequestException(
        'At least one of phone, name, password, role, new_geo_entity_id, new_role_title, new_staff_notes, deactivate or reactivate required',
      );
    }

    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (
      staffFieldsPresent &&
      user.role !== null &&
      (PROTECTED_ROLES as readonly string[]).includes(user.role)
    ) {
      throw new ForbiddenException(
        'Staff fields cannot be set on dev/admin accounts',
      );
    }
    if (body.new_geo_entity_id !== undefined) {
      const geo = await this.geoEntityService.getById(body.new_geo_entity_id);
      if (!geo || geo.status !== 'operational' || geo.deleted_at !== null) {
        throw new UnprocessableEntityException(
          'new_geo_entity_id must reference an operational, non-deleted geo entity',
        );
      }
    }

    const options: UpdateUserOptions = { id };
    if (body.phone) options.new_external_id = body.phone;
    if (body.name) options.new_name = body.name;
    if (body.password)
      options.new_password_hash = await bcrypt.hash(body.password, 10);
    if (body.role) options.new_role = body.role;
    if (body.new_geo_entity_id !== undefined)
      options.new_geo_entity_id = body.new_geo_entity_id;
    if (body.new_role_title !== undefined)
      options.new_role_title = body.new_role_title.trim() || null;
    if (body.new_staff_notes !== undefined)
      options.new_staff_notes = body.new_staff_notes.trim() || null;
    if (body.deactivate === true) options.deactivate = true;
    if (body.reactivate === true) options.reactivate = true;

    const updated = await this.userService.update(options);
    if (!updated) {
      throw new NotFoundException('User not found');
    }

    return {
      id: updated.id,
      external_id: updated.external_id,
      name: updated.name,
      role: updated.role,
    };
  }

  @Delete(':idOrExternalId')
  async remove(@Param('idOrExternalId') idOrExternalId: string): Promise<{
    deleted: string[];
    failed: { input: string; reason: string }[];
  }> {
    return this.userService.delete(idOrExternalId);
  }

  @Post('bulk-delete')
  async bulkRemove(@Body() body: { identifiers: string[] }): Promise<{
    deleted: string[];
    failed: { input: string; reason: string }[];
  }> {
    if (!Array.isArray(body?.identifiers)) {
      throw new BadRequestException('identifiers must be an array');
    }
    return this.userService.delete(body.identifiers);
  }
}
