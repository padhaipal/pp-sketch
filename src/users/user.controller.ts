import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
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
  DashboardUserRow,
  UserMediaResponse,
  ScoreRow,
  LoginResponse,
  UserResponse,
  DeleteResponse,
  ActivityTimeRequestDto,
  ActivityTimeResponse,
} from './user.dto';
import { UserActivityService } from './user-activity.service';
import {
  addDays,
  istDateIso,
  istMidnightUtc,
} from '../notifier/report-card/report-card.utils';

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
  ) {}

  @Post('activity-time')
  async activityTime(
    @Body() body: ActivityTimeRequestDto,
  ): Promise<ActivityTimeResponse> {
    return this.userActivityService.getActivityTime(body);
  }

  @Get('dashboard')
  async dashboard(
    @Query('offset') offsetStr?: string,
  ): Promise<DashboardUserRow[]> {
    const offset = Math.max(0, parseInt(offsetStr || '0', 10) || 0);
    const limit = 100;

    // Find 100 most recently active user IDs
    const activeUsers = await this.mediaRepo
      .createQueryBuilder('mm')
      .select('mm.user_id', 'user_id')
      .addSelect('MAX(mm.created_at)', 'last_active')
      .where('mm.user_id IS NOT NULL')
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
      .select(['u.id', 'u.name', 'u.external_id'])
      .whereInIds(userIds)
      .getMany();

    const userMap = new Map(users.map((u) => [u.id, u]));

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
      activity.results.map((r) => [r.user_id, r.windows.map((w) => w.active_ms)]),
    );

    const dates = windows.map((_, i) => istDateIso(addDays(startMidIst, i)));

    return activeUsers.map((r) => {
      const user = userMap.get(r.user_id);
      const userActivity = activityByUser.get(r.user_id);
      return {
        id: r.user_id,
        name: user?.name ?? null,
        external_id: user?.external_id ?? '',
        activity: dates.map((date, i) => ({
          date,
          active_ms: userActivity?.[i] ?? 0,
        })),
      };
    });
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
        source: 'whatsapp' as any,
        media_type: 'audio' as any,
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
      }
    >();
    for (const ls of lessonStates) {
      if (lessonMap.has(ls.user_message_id)) continue;
      const transitionId: string | undefined = (ls.snapshot as any)?.context
        ?.stateTransitionId;
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
        word: ls.word,
        answer: ls.answer,
        answer_correct: ls.answer_correct,
        starting_state: startingState,
        final_state: finalState,
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

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      this.logger.warn(
        `Login failed: password mismatch phone=${toLogId(phone)}`,
      );
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.log(
      `Login success phone=${toLogId(phone)} id=${user.id}`,
    );
    return { id: user.id, external_id: user.external_id, role: user.role };
  }

  @Patch(':id')
  async patchUser(
    @Param('id') id: string,
    @Body() body: PatchUserDto,
  ): Promise<UserResponse> {
    if (!body.phone && !body.name && !body.password && !body.role) {
      throw new BadRequestException(
        'At least one of phone, name, password, or role required',
      );
    }

    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (body.phone) user.external_id = body.phone;
    if (body.name) user.name = body.name;
    if (body.password)
      user.password_hash = await bcrypt.hash(body.password, 10);
    if (body.role) user.role = body.role;
    await this.userRepo.save(user);

    return {
      id: user.id,
      external_id: user.external_id,
      name: user.name,
      role: user.role,
    };
  }

  @Delete(':id')
  async remove(@Param('id') id: string): Promise<DeleteResponse> {
    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.userRepo.remove(user);
    return { deleted: true };
  }
}
