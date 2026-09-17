import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { GeoEntityService } from '../../geo-entities/geo-entity.service';
import type {
  GeoEntity,
  GeoEntityType,
} from '../../geo-entities/geo-entity.dto';
import { DESCENDANTS_MAX_LIMIT } from '../../geo-entities/geo-entity.dto';
import { ageOn, inBand, LiteracyMetric } from './age-bands';
import {
  ACTIVE_WINDOW_DAYS,
  binOf,
  CHILD_TYPE_OF,
  ChildRow,
  compareStudents,
  DashboardRange,
  delta,
  GeoRef,
  meanOf,
  MOST_IMPROVED_LIMIT,
  MOST_IMPROVED_MIN_N,
  Official,
  passRate,
  populationSd,
  RootStats,
  ScoresResponse,
  SeriesPoint,
  SpotlightResponse,
  StudentRow,
  studentLabel,
  usingLifteracy,
} from './dashboard-scores.dto';

// Reads for the public teacher dashboard. Only test_results_geo_entity /
// test_results_student — never recomputes a score. The one deliberate
// exception is at school level (see students()): per-student `active` /
// `last_active_at` from literacy_lesson_states and `in_band` from
// users.birth_year/birth_month through age-bands.ts. Do not "optimise"
// those two joins away; they are not stored anywhere else.

interface GeoRowMetric {
  geo_entity_id: string;
  computed_for: string;
  n: number;
  pass: number;
  sum: number;
  sumsq: number;
  students_active: number;
  students_scored: number;
  students_unbanded: number;
}

function toRef(e: GeoEntity): GeoRef {
  return {
    id: e.id,
    type: e.type,
    code: e.code,
    name: e.name,
    has_boundary: e.has_boundary,
    lat: e.lat === null ? null : Number(e.lat),
    lng: e.lng === null ? null : Number(e.lng),
  };
}

function isoDate(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function metricColumns(metric: LiteracyMetric): string {
  return `${metric}_n::int AS n, ${metric}_pass::int AS pass, ${metric}_sum::float8 AS sum, ${metric}_sumsq::float8 AS sumsq, students_active, students_scored, students_unbanded`;
}

// A student row plus the internals the school/class levels aggregate over
// (never sent to the client — see toStudentRow).
interface MemberRow extends StudentRow {
  referrer_user_id: string | null;
  prior_score: number | null;
  prior_passed: boolean | null;
  unbanded: boolean;
}

function toStudentRow(m: MemberRow): StudentRow {
  return {
    student_id: m.student_id,
    label: m.label,
    name: m.name,
    score: m.score,
    passed: m.passed,
    attempts: m.attempts,
    in_band: m.in_band,
    active: m.active,
    last_active_at: m.last_active_at,
    delta: m.delta,
  };
}

// Pass rate of the group's prior rows (≤ as_of − range), for a delta.
function priorPassRate(members: MemberRow[]): number | null {
  const prior = members.filter((m) => m.prior_score !== null);
  return passRate(
    prior.filter((m) => m.prior_passed === true).length,
    prior.length,
  );
}

function rankImproved(children: ChildRow[]): ChildRow[] {
  return children
    .filter((c) => c.n >= MOST_IMPROVED_MIN_N && c.delta !== null)
    .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
    .slice(0, MOST_IMPROVED_LIMIT);
}

function emptyResponse(
  entity: GeoRef,
  childType: ScoresResponse['child_type'],
  metric: LiteracyMetric,
  range: DashboardRange,
): ScoresResponse {
  return {
    as_of: null,
    metric,
    range,
    entity,
    root: {
      pass_rate: null,
      mean: null,
      sd: null,
      n: null,
      students_active: null,
      students_unbanded: null,
      delta: null,
    },
    series: [],
    child_type: childType,
    children: [],
    most_improved: [],
  };
}

@Injectable()
export class DashboardScoresService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly geoEntityService: GeoEntityService,
  ) {}

  async scores(
    id: string,
    metric: LiteracyMetric,
    range: DashboardRange,
  ): Promise<ScoresResponse> {
    const entity = await this.geoEntityService.getById(id);
    // Not a geo entity → a teacher's user id (the class level under a school).
    if (!entity) return this.classScores(id, metric, range);
    const childType = CHILD_TYPE_OF[entity.type];

    const latest = await this.latestRow(id, metric);
    if (!latest) {
      // A new school, or any entity before its first nightly run: 200 with
      // nulls — a brand-new teacher's first visit is when the share link
      // matters most.
      return emptyResponse(toRef(entity), childType, metric, range);
    }
    const asOf = isoDate(latest.computed_for);
    const prior = await this.priorRows([id], metric, asOf, range);
    const rootPass = passRate(latest.pass, latest.n);
    const root: RootStats = {
      pass_rate: rootPass,
      mean: meanOf(latest.sum, latest.n),
      sd: populationSd(latest.sum, latest.sumsq, latest.n),
      n: latest.n,
      students_active: latest.students_active,
      students_unbanded: latest.students_unbanded,
      delta: delta(rootPass, prior.get(id)),
    };
    const series = await this.series(id, metric, asOf, range);

    let children: ChildRow[] | StudentRow[];
    let mostImproved: ChildRow[] = [];
    if (childType === 'teacher') {
      const members = await this.students({ school: id }, metric, asOf, range);
      children = await this.teachers(members);
      mostImproved = rankImproved(children);
    } else if (childType && childType !== 'student') {
      children = await this.geoChildren(entity, childType, metric, asOf, range);
      mostImproved = rankImproved(children);
    } else {
      children = [];
    }

    return {
      as_of: asOf,
      metric,
      range,
      entity: toRef(entity),
      root,
      series,
      child_type: childType,
      children,
      most_improved: mostImproved,
    };
  }

  // ─── Class level (`:id` = a teacher's user id) ────────────────────────

  // The teacher's class = the students they referred. Everything is derived
  // from those students' test_results_student rows: no geo vector exists
  // for a teacher, so root/series are aggregated here (one small GROUP BY
  // for the series). 404 when the id is neither a geo entity nor a user.
  private async classScores(
    teacherId: string,
    metric: LiteracyMetric,
    range: DashboardRange,
  ): Promise<ScoresResponse> {
    const teacher: Array<{ id: string; name: string | null }> =
      await this.dataSource.query(
        `/* dashboard-scores:teacher */
         SELECT id, name FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [teacherId],
      );
    if (!teacher[0]) throw new NotFoundException('Geo entity not found');
    const entity: GeoRef = {
      id: teacherId,
      type: 'teacher',
      code: '',
      name: teacher[0].name ?? 'Teacher',
      has_boundary: false,
      lat: null,
      lng: null,
    };
    const asOfRows: Array<{ computed_for: string | Date | null }> =
      await this.dataSource.query(
        `/* dashboard-scores:class-as-of */
         SELECT MAX(t.computed_for) AS computed_for
         FROM test_results_student t
         JOIN users u ON u.id = t.student_id
         WHERE u.referrer_user_id = $1 AND u.role = 'student' AND u.deleted_at IS NULL`,
        [teacherId],
      );
    const computedFor = asOfRows[0]?.computed_for ?? null;
    if (!computedFor) return emptyResponse(entity, 'student', metric, range);
    const asOf = isoDate(computedFor);

    const members = await this.students(
      { teacher: teacherId },
      metric,
      asOf,
      range,
    );
    const scored = members.filter((m) => m.score !== null);
    const n = scored.length;
    const sum = scored.reduce((a, m) => a + (m.score ?? 0), 0);
    const sumsq = scored.reduce((a, m) => a + (m.score ?? 0) ** 2, 0);
    const rootPass = passRate(
      scored.filter((m) => m.passed === true).length,
      n,
    );
    const root: RootStats = {
      pass_rate: rootPass,
      mean: meanOf(sum, n),
      sd: populationSd(sum, sumsq, n),
      n,
      students_active: members.filter((m) => m.active).length,
      students_unbanded: members.filter((m) => m.unbanded).length,
      delta: delta(rootPass, priorPassRate(members)),
    };

    interface SeriesRow {
      computed_for: string | Date;
      n: number;
      pass: number;
    }
    const seriesRows: SeriesRow[] = await this.dataSource.query(
      `/* dashboard-scores:class-series */
       SELECT t.computed_for,
              COUNT(*) FILTER (WHERE t.${metric}_score IS NOT NULL)::int AS n,
              COUNT(*) FILTER (WHERE t.${metric}_passed)::int AS pass
       FROM test_results_student t
       JOIN users u ON u.id = t.student_id
       WHERE u.referrer_user_id = $1 AND u.role = 'student' AND u.deleted_at IS NULL
         AND t.computed_for > ($2::date - ($3 || ' days')::interval)
         AND t.computed_for <= $2::date
       GROUP BY t.computed_for
       ORDER BY t.computed_for`,
      [teacherId, asOf, String(range)],
    );

    return {
      as_of: asOf,
      metric,
      range,
      entity,
      root,
      series: seriesRows.map((r) => ({
        date: isoDate(r.computed_for),
        pass_rate: passRate(r.pass, r.n),
        n: r.n,
      })),
      child_type: 'student',
      children: members.map(toStudentRow),
      most_improved: [],
    };
  }

  async spotlight(
    id: string,
    metric: LiteracyMetric,
    range: DashboardRange,
  ): Promise<SpotlightResponse> {
    const result = await this.scores(id, metric, range);
    if (result.child_type === 'student' || result.child_type === null) {
      return { top: null, most_improved: null };
    }
    const children = (result.children as ChildRow[]).filter(
      (c) => c.n >= MOST_IMPROVED_MIN_N,
    );
    const top = [...children]
      .filter((c) => c.pass_rate !== null)
      .sort((a, b) => (b.pass_rate ?? 0) - (a.pass_rate ?? 0))[0];
    const improved = result.most_improved[0];
    return {
      top: top ? { child: top, official: top.official } : null,
      most_improved: improved
        ? { child: improved, official: improved.official }
        : null,
    };
  }

  // ─── Roots ────────────────────────────────────────────────────────────

  private async latestRow(
    id: string,
    metric: LiteracyMetric,
  ): Promise<GeoRowMetric | null> {
    const rows: GeoRowMetric[] = await this.dataSource.query(
      `/* dashboard-scores:latest */
       SELECT geo_entity_id, computed_for, ${metricColumns(metric)}
       FROM test_results_geo_entity
       WHERE geo_entity_id = $1
       ORDER BY computed_for DESC
       LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  // Newest row dated ≤ as_of − range days, per entity → its pass rate.
  private async priorRows(
    ids: string[],
    metric: LiteracyMetric,
    asOf: string,
    range: DashboardRange,
  ): Promise<Map<string, number | null>> {
    if (ids.length === 0) return new Map();
    const rows: GeoRowMetric[] = await this.dataSource.query(
      `/* dashboard-scores:prior */
       SELECT DISTINCT ON (geo_entity_id) geo_entity_id, computed_for, ${metricColumns(metric)}
       FROM test_results_geo_entity
       WHERE geo_entity_id = ANY($1::uuid[])
         AND computed_for <= ($2::date - ($3 || ' days')::interval)
       ORDER BY geo_entity_id, computed_for DESC`,
      [ids, asOf, String(range)],
    );
    return new Map(rows.map((r) => [r.geo_entity_id, passRate(r.pass, r.n)]));
  }

  private async series(
    id: string,
    metric: LiteracyMetric,
    asOf: string,
    range: DashboardRange,
  ): Promise<SeriesPoint[]> {
    const rows: GeoRowMetric[] = await this.dataSource.query(
      `/* dashboard-scores:series */
       SELECT geo_entity_id, computed_for, ${metricColumns(metric)}
       FROM test_results_geo_entity
       WHERE geo_entity_id = $1
         AND computed_for > ($2::date - ($3 || ' days')::interval)
         AND computed_for <= $2::date
       ORDER BY computed_for`,
      [id, asOf, String(range)],
    );
    return rows.map((r) => ({
      date: isoDate(r.computed_for),
      pass_rate: passRate(r.pass, r.n),
      n: r.n,
    }));
  }

  // ─── Geo children (one hop via descendants) ───────────────────────────

  private async allDescendants(
    id: string,
    type: GeoEntityType,
  ): Promise<GeoRef[]> {
    const out: GeoRef[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.geoEntityService.descendants(id, type, {
        cursor,
        limit: DESCENDANTS_MAX_LIMIT,
      });
      for (const item of page.items) {
        out.push({
          id: item.id,
          type,
          code: item.code,
          name: item.name,
          has_boundary: item.has_boundary,
          lat: item.lat === null ? null : Number(item.lat),
          lng: item.lng === null ? null : Number(item.lng),
        });
      }
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }

  private async geoChildren(
    entity: GeoEntity,
    childType: Exclude<GeoEntityType, 'cluster' | 'country'>,
    metric: LiteracyMetric,
    asOf: string,
    range: DashboardRange,
  ): Promise<ChildRow[]> {
    const refs = await this.allDescendants(entity.id, childType);
    if (refs.length === 0) return [];
    const ids = refs.map((r) => r.id);
    const [rows, prior, officials] = await Promise.all([
      this.childRows(ids, metric, asOf),
      this.priorRows(ids, metric, asOf, range),
      this.officials(ids),
    ]);
    const byId = new Map(rows.map((r) => [r.geo_entity_id, r]));
    return refs.map((ref) => {
      const row = byId.get(ref.id);
      const using = usingLifteracy(row);
      const pr = row ? passRate(row.pass, row.n) : null;
      return {
        ...ref,
        pass_rate: pr,
        n: row?.n ?? 0,
        students_active: row?.students_active ?? 0,
        using_lifteracy: using,
        delta: delta(pr, prior.get(ref.id)),
        bin: binOf(pr, using),
        official: officials.get(ref.id) ?? null,
      };
    });
  }

  private async childRows(
    ids: string[],
    metric: LiteracyMetric,
    asOf: string,
  ): Promise<GeoRowMetric[]> {
    const rows: GeoRowMetric[] = await this.dataSource.query(
      `/* dashboard-scores:children */
       SELECT geo_entity_id, computed_for, ${metricColumns(metric)}
       FROM test_results_geo_entity
       WHERE geo_entity_id = ANY($1::uuid[]) AND computed_for = $2::date`,
      [ids, asOf],
    );
    return rows;
  }

  // The newest non-deleted education_official per child — on EVERY child,
  // because the teacher modal opens from any row.
  private async officials(ids: string[]): Promise<Map<string, Official>> {
    const rows: Array<Official & { geo_entity_id: string }> =
      await this.dataSource.query(
        `/* dashboard-scores:officials */
         SELECT DISTINCT ON (geo_entity_id) geo_entity_id, name, role_title,
                avatar_seed, spotlight_message
         FROM users
         WHERE geo_entity_id = ANY($1::uuid[])
           AND role = 'education_official' AND deleted_at IS NULL
         ORDER BY geo_entity_id, created_at DESC`,
        [ids],
      );
    return new Map(
      rows.map(({ geo_entity_id, ...official }) => [geo_entity_id, official]),
    );
  }

  // ─── Students (school level → grouped into teachers; class level) ─────

  // School scope: membership is the student's LATEST test_results_student
  // row's geo_entity_id — the compute-time school the geo vectors were
  // built from — not referrer.geo_entity_id, which may have moved since
  // the nightly run; a student must never be inside one school's n while
  // listed under another. A student with any row for this school is a
  // candidate; only those whose latest row is still here are members.
  // Class scope: membership is `users.referrer_user_id = teacher` —
  // wherever the student's latest row sits.
  // Each row also carries the student's newest row dated ≤ as_of − range
  // (prior_score / prior_passed) for deltas.
  private async students(
    scope: { school: string } | { teacher: string },
    metric: LiteracyMetric,
    asOf: string,
    range: DashboardRange,
  ): Promise<MemberRow[]> {
    interface Row {
      student_id: string;
      name: string | null;
      created_at: Date;
      birth_year: number | null;
      birth_month: number | null;
      referrer_user_id: string | null;
      score: number | null;
      passed: boolean | null;
      attempts: number;
      last_active_at: Date | null;
      prior_score: number | null;
      prior_passed: boolean | null;
    }
    const bySchool = 'school' in scope;
    const rows: Row[] = await this.dataSource.query(
      `/* dashboard-scores:${bySchool ? 'students' : 'class'} */
       WITH members AS (
         ${
           bySchool
             ? `SELECT DISTINCT student_id FROM test_results_student WHERE geo_entity_id = $1`
             : `SELECT u.id AS student_id FROM users u
                WHERE u.referrer_user_id = $1 AND u.role = 'student' AND u.deleted_at IS NULL`
         }
       ),
       latest AS (
         SELECT DISTINCT ON (t.student_id) t.*
         FROM test_results_student t
         JOIN members m ON m.student_id = t.student_id
         ORDER BY t.student_id, t.created_at DESC
       ),
       prior AS (
         SELECT DISTINCT ON (t.student_id) t.student_id,
                t.${metric}_score::float8 AS prior_score, t.${metric}_passed AS prior_passed
         FROM test_results_student t
         JOIN members m ON m.student_id = t.student_id
         WHERE t.computed_for <= ($2::date - ($3 || ' days')::interval)
         ORDER BY t.student_id, t.computed_for DESC
       ),
       -- Deliberate read outside the results tables: active/last_active_at
       -- are not stored per student. One grouped MAX, not an EXISTS + MAX.
       activity AS (
         SELECT l.user_id, MAX(l.created_at) AS last_active_at
         FROM literacy_lesson_states l
         JOIN members m ON m.student_id = l.user_id
         GROUP BY l.user_id
       )
       SELECT l.student_id, u.name, u.created_at, u.birth_year, u.birth_month,
              u.referrer_user_id,
              l.${metric}_score::float8 AS score, l.${metric}_passed AS passed,
              l.${metric}_attempts::int AS attempts, a.last_active_at,
              p.prior_score, p.prior_passed
       FROM latest l
       JOIN users u ON u.id = l.student_id
       LEFT JOIN activity a ON a.user_id = l.student_id
       LEFT JOIN prior p ON p.student_id = l.student_id
       WHERE ${bySchool ? 'l.geo_entity_id = $1 AND ' : ''}u.role = 'student' AND u.deleted_at IS NULL`,
      [bySchool ? scope.school : scope.teacher, asOf, String(range)],
    );
    const asOfDate = new Date(`${asOf}T00:00:00Z`);
    const activeSince = asOfDate.getTime() - ACTIVE_WINDOW_DAYS * 86_400_000;
    // Stable ordinal: by created_at among the current members.
    const ordinal = new Map(
      [...rows]
        .sort(
          (a, b) =>
            new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime() ||
            (a.student_id < b.student_id ? -1 : 1),
        )
        .map((r, i) => [r.student_id, i + 1]),
    );
    const out: MemberRow[] = rows.map((r) => {
      // Deliberate read of users.birth_year/birth_month: in_band is not
      // stored per student either.
      const age = ageOn(asOfDate, r.birth_year, r.birth_month);
      const lastActive = r.last_active_at ? new Date(r.last_active_at) : null;
      const priorScore = r.prior_score ?? null;
      return {
        student_id: r.student_id,
        label: studentLabel(r.name, ordinal.get(r.student_id) ?? 0),
        name: r.name,
        score: r.score,
        passed: r.passed,
        attempts: r.attempts,
        in_band: inBand(metric, age),
        active: lastActive !== null && lastActive.getTime() >= activeSince,
        last_active_at: lastActive ? lastActive.toISOString() : null,
        delta: delta(
          r.score === null ? null : r.score * 100,
          priorScore === null ? null : priorScore * 100,
        ),
        referrer_user_id: r.referrer_user_id ?? null,
        prior_score: priorScore,
        prior_passed: r.prior_passed ?? null,
        unbanded: age === null,
      };
    });
    return out.sort(compareStudents);
  }

  // School level: one ChildRow per referrer (teacher) of the school's
  // members, aggregated from their students' rows — pass rate over scored
  // students, delta against the students' prior rows, the teacher's own
  // profile as `official`. Ordered pass_rate desc, then name.
  private async teachers(members: MemberRow[]): Promise<ChildRow[]> {
    const groups = new Map<string, MemberRow[]>();
    for (const m of members) {
      if (!m.referrer_user_id) continue;
      const g = groups.get(m.referrer_user_id);
      if (g) g.push(m);
      else groups.set(m.referrer_user_id, [m]);
    }
    if (groups.size === 0) return [];
    const users: Array<Official & { id: string }> = await this.dataSource.query(
      `/* dashboard-scores:teachers */
       SELECT id, name, role_title, avatar_seed, spotlight_message
       FROM users
       WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
      [[...groups.keys()]],
    );
    const byId = new Map(users.map((u) => [u.id, u]));
    const rows: ChildRow[] = [...groups].map(([id, studs]) => {
      const scored = studs.filter((s) => s.score !== null);
      const pr = passRate(
        scored.filter((s) => s.passed === true).length,
        scored.length,
      );
      const u = byId.get(id);
      return {
        id,
        type: 'teacher',
        code: '',
        name: u?.name ?? 'Teacher',
        has_boundary: false,
        lat: null,
        lng: null,
        pass_rate: pr,
        n: scored.length,
        students: studs.length,
        students_active: studs.filter((s) => s.active).length,
        using_lifteracy: true,
        delta: delta(pr, priorPassRate(studs)),
        bin: binOf(pr, true),
        official: u
          ? {
              name: u.name,
              role_title: u.role_title ?? 'Teacher',
              avatar_seed: u.avatar_seed,
              spotlight_message: u.spotlight_message,
            }
          : null,
      };
    });
    return rows.sort(
      (a, b) =>
        (b.pass_rate ?? -1) - (a.pass_rate ?? -1) ||
        a.name.localeCompare(b.name),
    );
  }
}
