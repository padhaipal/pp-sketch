import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CacheService } from '../interfaces/redis/cache';
import { CACHE_KEYS, CACHE_TTL } from '../interfaces/redis/cache.dto';
import { addDays, istDateIso } from '../notifier/report-card/report-card.utils';
import { onboardingCutoff } from '../onboarding/onboarding.config';
import {
  FIVE_MIN_MS,
  IST_DATE_SQL,
  PER_USER_DAY_ACTIVE_CTES,
} from './daily-activity.sql';
import {
  buildTraction,
  TRACTION_FROM,
  type TractionInputs,
  type TractionResponse,
  type UnitRef,
} from './traction';

// The public traction series (GET users/dashboard/traction — the donor
// page's "Traction" chart): one row per complete IST day from
// TRACTION_FROM, aggregates only (traction.ts has the definitions).
//
// Computed at most once a day: the answer is cached in pp-redis-cache under
// the IST date it was computed on (CACHE_KEYS.traction), so the day rolls
// over at IST midnight rather than 24 h after the first visitor. A
// concurrent miss shares the one in-flight computation (single-flight per
// process). The traction-warm job (main.ts, 01:30 IST — after the 00:15 IST
// nightly test results) recomputes and overwrites the day's key, so no
// visitor waits and the MPL-B figure includes last night's results.
@Injectable()
export class TractionService {
  private readonly logger = new Logger(TractionService.name);
  private inflight: Promise<TractionResponse> | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly cacheService: CacheService,
  ) {}

  async get(now: Date = new Date()): Promise<TractionResponse> {
    const key = CACHE_KEYS.traction(istDateIso(now));
    const cached = await this.cacheService.get<TractionResponse>(key);
    if (cached) return cached;
    return this.computeShared(now);
  }

  // The warm job: recompute and overwrite today's key.
  async refresh(now: Date = new Date()): Promise<TractionResponse> {
    return this.computeShared(now);
  }

  private computeShared(now: Date): Promise<TractionResponse> {
    if (!this.inflight) {
      this.inflight = this.compute(now).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async compute(now: Date): Promise<TractionResponse> {
    const started = Date.now();
    const today = istDateIso(now);
    const to = istDateIso(addDays(new Date(`${today}T00:00:00Z`), -1));
    const inputs = await this.readInputs();
    const response = buildTraction(inputs, TRACTION_FROM, to, now);
    await this.cacheService.set(
      CACHE_KEYS.traction(today),
      response,
      CACHE_TTL.TRACTION,
    );
    this.logger.log(
      `traction.computed days=${response.daily.length} to=${to} ms=${Date.now() - started}`,
    );
    return response;
  }

  private async readInputs(): Promise<TractionInputs> {
    const db = this.dataSource;
    const cutoff = onboardingCutoff();
    const [activityRows, studentRows, teacherRows, mplbRows] =
      await Promise.all([
        // per IST day ('d') and per user lifetime ('u') from one scan
        db.query<
          Array<{
            k: 'd' | 'u';
            date: string | null;
            user_id: string | null;
            users_over_5min: number | null;
            active_ms: string | number;
          }>
        >(
          `/* traction:activity */
           WITH ${PER_USER_DAY_ACTIVE_CTES()}
           SELECT 'd' AS k, ist_date::text AS date, NULL::uuid AS user_id,
                  COUNT(*) FILTER (WHERE active_ms > $1)::int AS users_over_5min,
                  ROUND(SUM(active_ms)) AS active_ms
           FROM per_user_day
           GROUP BY ist_date
           UNION ALL
           SELECT 'u', NULL, user_id, NULL, ROUND(SUM(active_ms))
           FROM per_user_day
           GROUP BY user_id`,
          [FIVE_MIN_MS],
        ),
        // onboarded students (UserService.isOnboarded): grandfathered by
        // created_at before the cutoff, else onboarding wrote birth_year +
        // recording permission (the onboarding day). Each with the geo
        // chain of their referrer's entity, up to the state.
        db.query<
          Array<{
            id: string;
            onboarded_on: string;
            units: UnitRef[] | null;
          }>
        >(
          `/* traction:students */
           WITH RECURSIVE s AS (
             SELECT u.id, u.referrer_user_id,
                    ${IST_DATE_SQL(
                      `(CASE WHEN u.created_at < $1 THEN u.created_at
                             ELSE u.recording_permissions_obtained_at END)`,
                    )}::text AS onboarded_on
             FROM users u
             WHERE COALESCE(u.role, 'student') = 'student'
               AND u.deleted_at IS NULL
               AND (u.created_at < $1
                    OR (u.birth_year IS NOT NULL
                        AND u.recording_permissions_obtained_at IS NOT NULL))
           ),
           roots AS (
             SELECT DISTINCT r.geo_entity_id AS id
             FROM s JOIN users r ON r.id = s.referrer_user_id
             WHERE r.geo_entity_id IS NOT NULL
           ),
           up AS (
             SELECT g.id AS root_id, g.id, g.type::text AS type, g.parent_id
             FROM roots JOIN geo_entity g ON g.id = roots.id
             UNION ALL
             SELECT up.root_id, p.id, p.type::text, p.parent_id
             FROM up JOIN geo_entity p ON p.id = up.parent_id
           )
           SELECT s.id, s.onboarded_on,
                  (SELECT json_agg(json_build_object('id', up.id, 'type', up.type))
                   FROM users r JOIN up ON up.root_id = r.geo_entity_id
                   WHERE r.id = s.referrer_user_id) AS units
           FROM s`,
          [cutoff],
        ),
        // teacher accounts: education officials on a school
        db.query<Array<{ created_on: string }>>(
          `/* traction:teachers */
           SELECT ${IST_DATE_SQL('u.created_at')}::text AS created_on
           FROM users u
           JOIN geo_entity g ON g.id = u.geo_entity_id
           WHERE u.role = 'education_official' AND g.type = 'school'
             AND u.deleted_at IS NULL`,
        ),
        db.query<
          Array<{
            student_id: string;
            computed_for: string;
            mpl_b_passed: boolean | null;
          }>
        >(
          `/* traction:mplb */
           SELECT t.student_id, t.computed_for::text AS computed_for,
                  t.mpl_b_passed
           FROM test_results_student t
           JOIN users u ON u.id = t.student_id AND u.deleted_at IS NULL`,
        ),
      ]);

    const activityByDay: TractionInputs['activityByDay'] = [];
    const lifetimeMsByUser = new Map<string, number>();
    for (const r of activityRows) {
      if (r.k === 'd' && r.date) {
        activityByDay.push({
          date: r.date,
          users_over_5min: Number(r.users_over_5min ?? 0),
          active_ms: Number(r.active_ms),
        });
      } else if (r.k === 'u' && r.user_id) {
        lifetimeMsByUser.set(r.user_id, Number(r.active_ms));
      }
    }
    return {
      activityByDay,
      lifetimeMsByUser,
      students: studentRows
        .filter((r) => r.onboarded_on)
        .map((r) => ({
          id: r.id,
          onboarded_on: r.onboarded_on,
          units: r.units ?? [],
        })),
      teacherDays: teacherRows.map((r) => r.created_on),
      mplb: mplbRows.map((r) => ({
        student_id: r.student_id,
        computed_for: r.computed_for,
        passed: r.mpl_b_passed,
      })),
    };
  }
}
