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
import { LoginDto, PatchUserDto } from './user.dto';

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
  ) {}

  @Get('dashboard')
  async dashboard(@Query('offset') offsetStr?: string) {
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

    // Fetch 7-day activity counts per user per day
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const activityRows = await this.mediaRepo
      .createQueryBuilder('mm')
      .select('mm.user_id', 'user_id')
      .addSelect('DATE(mm.created_at)', 'date')
      .addSelect('COUNT(*)::int', 'count')
      .where('mm.user_id IN (:...userIds)', { userIds })
      .andWhere('mm.created_at >= :since', { since: sevenDaysAgo })
      .groupBy('mm.user_id')
      .addGroupBy('DATE(mm.created_at)')
      .getRawMany<{ user_id: string; date: string; count: number }>();

    // Build activity map: userId -> { date -> count }
    const activityMap = new Map<string, Map<string, number>>();
    for (const row of activityRows) {
      if (!activityMap.has(row.user_id)) activityMap.set(row.user_id, new Map());
      const dateStr = new Date(row.date).toISOString().slice(0, 10);
      activityMap.get(row.user_id)!.set(dateStr, Number(row.count));
    }

    // Generate 7-day date range
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(sevenDaysAgo);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0, 10));
    }

    // Assemble response in last_active order
    return activeUsers.map((r) => {
      const user = userMap.get(r.user_id);
      const userActivity = activityMap.get(r.user_id);
      return {
        id: r.user_id,
        name: user?.name ?? null,
        external_id: user?.external_id ?? '',
        activity: dates.map((date) => ({
          date,
          count: userActivity?.get(date) ?? 0,
        })),
      };
    });
  }

  @Get(':id/media')
  async userMedia(
    @Param('id') id: string,
    @Query('offset') offsetStr?: string,
  ) {
    const offset = Math.max(0, parseInt(offsetStr || '0', 10) || 0);
    const limit = 100;

    // Fetch user details
    const user = await this.userRepo.findOneBy({ id });
    if (!user) throw new NotFoundException('User not found');

    // 100 most recent whatsapp audio for this user
    const media = await this.mediaRepo.find({
      where: { user_id: id, source: 'whatsapp' as any, media_type: 'audio' as any },
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
      .select(['mm.id', 'mm.input_media_id', 'mm.text', 'mm.source'])
      .where('mm.input_media_id IN (:...mediaIds)', { mediaIds })
      .getMany();

    // Group transcripts by input_media_id
    const transcriptMap = new Map<string, { text: string | null; source: string }[]>();
    for (const t of transcripts) {
      if (!t.input_media_id) continue;
      if (!transcriptMap.has(t.input_media_id)) transcriptMap.set(t.input_media_id, []);
      transcriptMap.get(t.input_media_id)!.push({ text: t.text, source: t.source });
    }

    return {
      user: { name: user.name, phone: user.external_id },
      media: media.map((m) => ({
        id: m.id,
        created_at: m.created_at,
        has_audio: !!m.s3_key,
        transcripts: transcriptMap.get(m.id) ?? [],
      })),
    };
  }

  @Get(':id/scores')
  async userScores(@Param('id') id: string) {
    const scores = await this.scoreRepo
      .createQueryBuilder('s')
      .innerJoinAndSelect('s.letter', 'l')
      .select(['s.id', 's.score', 's.created_at', 's.letter_id', 'l.grapheme'])
      .where('s.user_id = :id', { id })
      .orderBy('s.created_at', 'ASC')
      .getMany();

    return scores.map((s) => ({
      score: s.score,
      created_at: s.created_at,
      letter_id: s.letter_id,
      grapheme: s.letter.grapheme,
    }));
  }

  @Post('login')
  async login(@Body() body: LoginDto) {
    const { phone, password } = body;
    this.logger.log(`[HPTRACE] login attempt phone=${phone}`);

    if (!phone || !password) {
      this.logger.warn(`[HPTRACE] login missing fields phone=${!!phone} password=${!!password}`);
      throw new BadRequestException('phone and password required');
    }

    const user = await this.userRepo.findOneBy({ external_id: phone });
    if (!user || !user.password_hash || !user.role) {
      this.logger.warn(`[HPTRACE] login user not found or missing hash/role phone=${phone} found=${!!user}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      this.logger.warn(`[HPTRACE] login password mismatch phone=${phone}`);
      throw new UnauthorizedException('Invalid credentials');
    }

    this.logger.log(`[HPTRACE] login success phone=${phone} id=${user.id} role=${user.role}`);
    return { id: user.id, external_id: user.external_id, role: user.role };
  }

  @Patch(':id')
  async patchUser(@Param('id') id: string, @Body() body: PatchUserDto) {
    if (!body.phone && !body.name && !body.password && !body.role) {
      throw new BadRequestException('At least one of phone, name, password, or role required');
    }

    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (body.phone) user.external_id = body.phone;
    if (body.name) user.name = body.name;
    if (body.password) user.password_hash = await bcrypt.hash(body.password, 10);
    if (body.role) user.role = body.role;
    await this.userRepo.save(user);

    return { id: user.id, external_id: user.external_id, name: user.name, role: user.role };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.userRepo.remove(user);
    return { deleted: true };
  }
}
