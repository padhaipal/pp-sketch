import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { STAFF, type ViewerContext } from '../../auth/viewer';
import { CacheService } from '../../interfaces/redis/cache';
import {
  LlmError,
  LlmProvider,
  LlmRequest,
  LlmResult,
  VALID_LLM_PROVIDERS,
} from '../../interfaces/llm/llm.dto';
import { AnthropicLlmService } from '../../interfaces/llm/anthropic/anthropic-llm.service';
import { OpenaiLlmService } from '../../interfaces/llm/openai/openai-llm.service';
import { MistralLlmService } from '../../interfaces/llm/mistral/mistral-llm.service';
import { SarvamLlmService } from '../../interfaces/llm/sarvam/sarvam-llm.service';
import { referralUrl } from '../../interfaces/dashboard/dashboard-url';
import { GeoEntityService } from '../../geo-entities/geo-entity.service';
import type { GeoEntity } from '../../geo-entities/geo-entity.dto';
import { DashboardScoresService } from './dashboard-scores.service';
import {
  ChildRow,
  ScoresResponse,
  StudentRow,
  VERDICT_METRIC,
  VerdictStats,
} from './dashboard-scores.dto';
import type { LiteracyMetric } from './age-bands';

// ─── Config ──────────────────────────────────────────────────────────────────

// A page load waits on this call, so: one attempt, a hard timeout, and a
// model that answers in a couple of seconds. Anthropic's small model by
// default — strong Hindi, no shared rate cap (Sarvam's 40 rpm is pooled with
// the passage gates; Google is reserved for the onboarding classifier).
export const SHARE_MESSAGE_DEFAULT_PROVIDER: LlmProvider = 'anthropic';
export const SHARE_MESSAGE_DEFAULT_MODEL = 'claude-haiku-5-5';
export const SHARE_MESSAGE_TIMEOUT_MS = 15_000;
// Devanagari tokenises at roughly three tokens a word, so a six-line Hindi
// message is 600–900 tokens by itself, and the model may spend hidden
// reasoning tokens out of the same budget: 700 came back empty or cut off
// on staging (2026-10-13). The prompt still asks for 3–6 lines; the cap is
// only a safety net.
export const SHARE_MESSAGE_MAX_TOKENS = 2500;
export const SHARE_MESSAGE_TEMPERATURE_RATIO = 0.9;
// Per viewer per minute — a refresh loop must not burn money.
export const SHARE_MESSAGE_RATE_LIMIT = 10;
export const SHARE_MESSAGE_RATE_WINDOW_S = 60;
export const SHARE_MESSAGE_MAX_CHARS = 1200;
const TOP_N = 3;
const verdictDecided = (v: VerdictStats): number =>
  v.schools_pass + v.schools_fail;

export function shareMessageLlm(): { provider: LlmProvider; model: string } {
  const provider = process.env.SHARE_MESSAGE_LLM_PROVIDER ?? '';
  const model =
    process.env.SHARE_MESSAGE_LLM_MODEL ?? SHARE_MESSAGE_DEFAULT_MODEL;
  if (!provider) return { provider: SHARE_MESSAGE_DEFAULT_PROVIDER, model };
  if (
    !(VALID_LLM_PROVIDERS as readonly string[]).includes(provider) ||
    provider === 'google'
  ) {
    throw new Error(
      `SHARE_MESSAGE_LLM_PROVIDER must be one of openai, anthropic, mistral, sarvam (got ${JSON.stringify(provider)}; google is reserved for the onboarding classifier)`,
    );
  }
  return { provider: provider as LlmProvider, model };
}

// ─── Who may ask, and for what ───────────────────────────────────────────────

// The message is for the viewer's OWN unit only: an official on their own
// geo entity (a BEO on their block, a BSA on their district) → the teachers'
// group; a teacher on their own class → the parents' group.
// Who the official's group is, by the level they run: a BEO writes to the
// block's teachers, a BSA to the district's BEOs, a DGSE to the state's
// BSAs, the national head to the state heads. The model gets this in words.
export const AREA_AUDIENCE: Record<GeoEntity['type'], string> = {
  school: 'the teachers of this school',
  cluster: 'the teachers of this cluster',
  block: 'the teachers of this block (sent by their BEO)',
  district:
    'the block education officers (BEOs) and teachers of this district (sent by their BSA)',
  state:
    'the district education officers (BSAs) of this state (sent by the state education head)',
  country:
    'the state education heads (DGSEs) of India (sent by the national education head)',
};

export type ShareSubject =
  | {
      kind: 'area';
      entity: GeoEntity;
      audience: 'teachers' | 'officials';
      audienceDescription: string;
    }
  | {
      kind: 'class';
      teacherId: string;
      schoolName: string | null;
      shareLink: string;
      audience: 'parents';
      audienceDescription: string;
    };

interface ViewerRow {
  id: string;
  role: string;
  geo_entity_id: string | null;
  external_id: string;
  geo_type: string | null;
  geo_name: string | null;
}

// ─── Facts (what the model sees — names only as placeholders) ───────────────

// Every person's name is handed to the model as `{{NAME_n}}` and put back
// after generation; place names (blocks, schools) are not personal data and
// go through as they are. Phones never leave the server.
export class Placeholders {
  private readonly byKey = new Map<string, string>();
  private readonly values: string[] = [];
  constructor(private readonly prefix = 'NAME') {}
  add(key: string, display: string): string {
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const token = `{{${this.prefix}_${this.values.length + 1}}}`;
    this.byKey.set(key, token);
    this.values.push(display);
    return token;
  }
  get entries(): Array<[token: string, value: string]> {
    return this.values.map((v, i) => [`{{${this.prefix}_${i + 1}}}`, v]);
  }
}

export interface ShareFacts {
  audience: 'teachers' | 'officials' | 'parents';
  // the group in words, e.g. "the BSAs of this state"
  audience_description: string;
  language: 'hi';
  as_of: string | null;
  unit: Record<string, unknown>;
  time_last_7_days?: Record<string, unknown>;
  time_yesterday?: Record<string, unknown>;
  tests: Record<string, unknown>;
  nipun_verdict?: Record<string, unknown>;
  teachers?: Array<Record<string, unknown>>;
  class?: Record<string, unknown>;
  share_link?: string;
  variety_seed: number;
}

const round1 = (v: number | null | undefined): number | null =>
  v == null ? null : Math.round(v * 10) / 10;

// A child area / school / teacher as a top-list entry. Teachers are people →
// placeholder; areas and schools are places → their name.
function childWho(c: ChildRow, names: Placeholders): string {
  return c.type === 'teacher' ? names.add(`t:${c.id}`, c.name) : c.name;
}
function studentWho(s: StudentRow, names: Placeholders): string {
  return names.add(`s:${s.student_id}`, s.name ?? s.label);
}

function topTime(
  r: ScoresResponse | null,
  names: Placeholders,
): Record<string, unknown> | undefined {
  if (!r || !r.window) return undefined;
  const rows = r.children;
  const isStudents = r.child_type === 'student';
  const entries = (isStudents ? (rows as StudentRow[]) : (rows as ChildRow[]))
    .map((row) => ({
      who: isStudents
        ? studentWho(row as StudentRow, names)
        : childWho(row as ChildRow, names),
      minutes: round1(
        isStudents
          ? (row as StudentRow).time_total
          : (row as ChildRow).time_sum,
      ),
      per_student: isStudents
        ? undefined
        : round1((row as ChildRow).time_total),
      times_the_window_before: isStudents
        ? ((row as StudentRow).delta ?? null)
        : ((row as ChildRow).delta ?? null),
    }))
    .filter((e) => e.minutes != null && e.minutes > 0)
    .sort((a, b) => (b.minutes as number) - (a.minutes as number));
  return {
    minutes_per_student: round1(r.root.time_total),
    total_minutes: round1(r.root.time_sum),
    days_covered: r.root.time_days ?? null,
    active_students_last_14_days: r.root.students_active,
    top: entries.slice(0, TOP_N),
    most_improved: [...entries]
      .filter((e) => (e.times_the_window_before ?? 0) > 1)
      .sort(
        (a, b) =>
          (b.times_the_window_before ?? 0) - (a.times_the_window_before ?? 0),
      )
      .slice(0, TOP_N),
  };
}

function testFacts(
  r: ScoresResponse | null,
  names: Placeholders,
): Record<string, unknown> | undefined {
  if (!r || r.as_of === null) return undefined;
  const isStudents = r.child_type === 'student';
  const rows = isStudents
    ? (r.children as StudentRow[])
        .filter((s) => s.score !== null)
        .map((s) => ({
          who: studentWho(s, names),
          score_pct: Math.round((s.score ?? 0) * 100),
          passed: s.passed,
          change_vs_7_days_ago: s.delta,
        }))
    : (r.children as ChildRow[])
        .filter((c) => c.using_lifteracy && c.pass_rate !== null)
        .map((c) => ({
          who: childWho(c, names),
          pass_rate_pct: Math.round(c.pass_rate ?? 0),
          students_scored: c.n,
          change_vs_7_days_ago: c.delta,
        }));
  const value = (e: Record<string, unknown>) =>
    (e.score_pct as number | undefined) ?? (e.pass_rate_pct as number) ?? 0;
  return {
    age_band_years: r.age_band ?? null,
    pass_mark_pct: r.pass_mark ?? null,
    students_scored: r.root.n,
    pass_rate_pct:
      r.root.pass_rate == null ? null : Math.round(r.root.pass_rate),
    change_vs_7_days_ago: r.root.delta,
    top: [...rows].sort((a, b) => value(b) - value(a)).slice(0, TOP_N),
    most_improved: [...rows]
      .filter((e) => e.change_vs_7_days_ago != null)
      .sort(
        (a, b) =>
          (b.change_vs_7_days_ago as number) -
          (a.change_vs_7_days_ago as number),
      )
      .filter((e) => (e.change_vs_7_days_ago as number) > 0)
      .slice(0, TOP_N),
  };
}

function verdictFacts(
  r: ScoresResponse | null,
): Record<string, unknown> | undefined {
  if (!r || r.as_of === null || !r.root.verdict) return undefined;
  const v = r.root.verdict;
  const kids = r.children as ChildRow[];
  return {
    schools_pass: v.schools_pass,
    schools_fail: v.schools_fail,
    schools_not_enough_data: v.schools_insufficient,
    share_of_decided_schools_passing_pct:
      r.root.pass_rate == null ? null : Math.round(r.root.pass_rate),
    decided_schools: verdictDecided(v),
    passing: kids
      .filter((c) => c.verdict?.school_passed === true)
      .map((c) => c.name)
      .slice(0, 5),
    ...(v.bands ? { bands: v.bands } : {}),
  };
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

export const SHARE_MESSAGE_SYSTEM_PROMPT = `You write ONE short WhatsApp message in Hindi for a Lifteracy group, from the facts you are given. Lifteracy teaches children to read Hindi over WhatsApp; the dashboard numbers describe their practice and reading-test proxies.

Audience: "teachers" = the teachers of one block / district, sent by their education official. "parents" = the parents of one class, sent by the teacher. audience_description says exactly who the group is and who is sending it; address them accordingly.
Address the audience as a plural - this message will be posted in a WhatsApp group with multiple people. So ‘abhibhavakon’ in Hindi

How to choose what to say:
- Pick ONE or TWO angles only. Never list everything. Each call must read differently from the last: use variety_seed to pick a different angle, opening and structure every time.
- Give priority to anything remarkable or unusual in the facts (one child or school with far more practice than the rest, a huge jump, a teacher who enrolled many children, a school that just passed NIPUN, nobody active this week…). Decide for yourself from the numbers what is remarkable — nothing is remarkable by definition.
- Otherwise pick among: the five-minutes-a-day habit; praising the top performers; praising the most improved; progress on the NIPUN proxies; a gentle nudge to those who have gone quiet; a thank-you for the effort so far.
- Use real numbers from the facts only. Never invent names, numbers, dates or links. If a figure is null or missing, do not mention it.
- If there have been no users so far, say something positive like ‘be the first to try it out! A great new app’ or mention a benefit of daily reading practice. Don’t explicitly say that no child has used it yet

Format rules (strict):
- Hindi only, Devanagari script. Digits may stay as digits.
- 3 to 6 short lines, warm and encouraging, like a message a respected teacher would send. At most one emoji per line and three in total.
- People are referred to ONLY by the exact placeholders given (for example {{NAME_2}}); copy them character for character and never write a real name.
- Never write a phone number.
- For parents: the last line invites parents to enrol / keep going through the link, written exactly as {{SHARE_LINK}} on its own line. For teachers: no link at all.
- Output the message text only — no title, no quotes, no explanation.
- don’t mention ‘Lifteracy’ directly - many of them don’t know the name

The user message is one JSON object of facts.`;

export function buildMessages(facts: ShareFacts): LlmRequest['messages'] {
  return [
    { role: 'system', content: SHARE_MESSAGE_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(facts) },
  ];
}

// ─── Finishing the model's text ──────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*[A-Z_]+_?\d*\s*\}\}/g;
const PHONE_RE = /\+?\d[\d\s-]{8,}\d/g;

// Put the names and the link back, drop any placeholder the model made up,
// strip anything that looks like a phone number (the link's digits are
// protected), trim and cap.
export function finishMessage(
  raw: string,
  entries: Array<[token: string, value: string]>,
  shareLink: string | null,
): string {
  let text = raw.trim();
  const LINK = '\u0000LINK\u0000';
  if (shareLink) text = text.replace(/\{\{\s*SHARE_LINK\s*\}\}/g, LINK);
  for (const [token, value] of entries) text = text.split(token).join(value);
  text = text.replace(PLACEHOLDER_RE, '').replace(PHONE_RE, '');
  if (shareLink) {
    if (!text.includes(LINK)) text = `${text}\n${LINK}`;
    text = text.split(LINK).join(shareLink);
  }
  text = text
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > SHARE_MESSAGE_MAX_CHARS) {
    text = text.slice(0, SHARE_MESSAGE_MAX_CHARS).trim();
  }
  return text;
}

export interface ShareMessageResponse {
  message: string;
  model: string;
  generated_at: string;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class ShareMessageService {
  private readonly logger = new Logger(ShareMessageService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly scores: DashboardScoresService,
    private readonly geoEntityService: GeoEntityService,
    private readonly cache: CacheService,
    private readonly anthropicLlmService: AnthropicLlmService,
    private readonly openaiLlmService: OpenaiLlmService,
    private readonly mistralLlmService: MistralLlmService,
    private readonly sarvamLlmService: SarvamLlmService,
  ) {}

  // GET geo-entities/:id/share-message. Nothing is stored: every call is a
  // fresh generation (the page asks on every load).
  async generate(
    id: string,
    viewer: ViewerContext,
  ): Promise<ShareMessageResponse> {
    const subject = await this.subjectFor(id, viewer);
    await this.rateLimit(viewer);
    const names = new Placeholders();
    const facts = await this.facts(subject, names);
    const { provider, model } = shareMessageLlm();
    let result: LlmResult;
    try {
      result = await this.llmFor(provider).complete(
        {
          model,
          messages: buildMessages(facts),
          max_tokens: SHARE_MESSAGE_MAX_TOKENS,
          temperatureRatio: SHARE_MESSAGE_TEMPERATURE_RATIO,
        },
        { maxAttempts: 1, timeoutMs: SHARE_MESSAGE_TIMEOUT_MS },
      );
    } catch (err) {
      // The provider's own words reach the console ("credit balance is too
      // low", "`temperature` is deprecated…") as a 503, not a bare 500 —
      // and the log line carries them too (only the trace did, 2026-10-13).
      if (err instanceof LlmError) {
        this.logger.error(
          `share-message ${subject.kind} id=${id} ${provider}/${model} failed: ${err.message}`,
        );
        throw new ServiceUnavailableException(
          `The message could not be written (${err.message.slice(0, 300)})`,
        );
      }
      throw err;
    }
    const message = finishMessage(
      result.text,
      names.entries,
      subject.kind === 'class' ? subject.shareLink : null,
    );
    this.logger.log(
      `share-message ${subject.kind} id=${id} model=${result.model} tokens=${result.completion_tokens ?? '?'} ms=${result.duration_ms}`,
    );
    return {
      message,
      model: result.model,
      generated_at: new Date().toISOString(),
    };
  }

  private llmFor(provider: LlmProvider) {
    switch (provider) {
      case 'openai':
        return this.openaiLlmService;
      case 'mistral':
        return this.mistralLlmService;
      case 'sarvam':
        return this.sarvamLlmService;
      default:
        return this.anthropicLlmService;
    }
  }

  // Who is asking must own the unit: a teacher their class (id = their user
  // id), an official their geo entity. Staff may ask for any unit (support).
  private async subjectFor(
    id: string,
    viewer: ViewerContext,
  ): Promise<ShareSubject> {
    if (viewer.kind === 'anonymous') {
      throw new ForbiddenException('The share message is for the unit owner');
    }
    const entity = await this.geoEntityService.getById(id);
    if (entity) {
      if (viewer.kind === 'user') {
        const me = await this.viewerRow(viewer.id);
        if (!me || me.geo_entity_id !== entity.id) {
          throw new ForbiddenException(
            'The share message is for the unit owner',
          );
        }
      }
      return {
        kind: 'area',
        entity,
        audience:
          entity.type === 'block' ||
          entity.type === 'school' ||
          entity.type === 'cluster'
            ? 'teachers'
            : 'officials',
        audienceDescription: AREA_AUDIENCE[entity.type],
      };
    }
    const teacher = await this.viewerRow(id);
    if (
      !teacher ||
      teacher.role !== 'education_official' ||
      teacher.geo_type !== 'school'
    ) {
      throw new NotFoundException('Geo entity not found');
    }
    if (viewer.kind === 'user' && viewer.id !== teacher.id) {
      throw new ForbiddenException('The share message is for the unit owner');
    }
    return {
      kind: 'class',
      teacherId: teacher.id,
      schoolName: teacher.geo_name,
      shareLink: referralUrl(teacher.external_id),
      audience: 'parents',
      audienceDescription:
        'the parents of the children in this class (sent by their teacher)',
    };
  }

  private async viewerRow(userId: string): Promise<ViewerRow | null> {
    const rows: ViewerRow[] = await this.dataSource.query(
      `/* share-message:viewer */
       SELECT u.id, u.role, u.geo_entity_id, u.external_id, g.type AS geo_type, g.name AS geo_name
       FROM users u
       LEFT JOIN geo_entity g ON g.id = u.geo_entity_id AND g.deleted_at IS NULL
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [userId],
    );
    return rows[0] ?? null;
  }

  private async rateLimit(viewer: ViewerContext): Promise<void> {
    if (viewer.kind !== 'user') return;
    const n = await this.cache.incr(
      `share-message:${viewer.id}`,
      SHARE_MESSAGE_RATE_WINDOW_S,
    );
    if (n !== null && n > SHARE_MESSAGE_RATE_LIMIT) {
      throw new HttpException(
        'Too many share messages requested; try again in a minute',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  // Every number the page itself can show, over the metrics the viewer could
  // toggle through — the model decides what is worth saying. Reads go through
  // DashboardScoresService as STAFF (names in full) because only placeholders
  // leave the server. One failing read drops that section, never the message.
  private async facts(
    subject: ShareSubject,
    names: Placeholders,
  ): Promise<ShareFacts> {
    const id = subject.kind === 'area' ? subject.entity.id : subject.teacherId;
    const read = (
      metric: LiteracyMetric | typeof VERDICT_METRIC,
      window?: 'yesterday' | '7d',
    ) =>
      this.scores.scores(id, metric, 30, window, STAFF).catch((err: Error) => {
        this.logger.warn(
          `share-message read ${metric}${window ? `/${window}` : ''} failed: ${err.message}`,
        );
        return null;
      });
    const area = subject.kind === 'area';
    const [week, yesterday, g1, g2, g3, mplB, verdict] = await Promise.all([
      read('usage', '7d'),
      read('usage', 'yesterday'),
      read('nipun_g1'),
      read('nipun_g2'),
      read('nipun_g3'),
      read('mpl_b'),
      area ? read(VERDICT_METRIC) : Promise.resolve(null),
    ]);
    const any = week ?? yesterday ?? g2 ?? g3 ?? mplB ?? g1;
    const facts: ShareFacts = {
      audience: subject.audience,
      audience_description: subject.audienceDescription,
      language: 'hi',
      as_of: any?.as_of ?? null,
      unit: area
        ? {
            type: subject.entity.type,
            name: subject.entity.name,
            children: any?.child_type ?? null,
            children_total:
              (any?.children as ChildRow[] | undefined)?.length ?? 0,
            children_using_lifteracy: (
              (any?.children ?? []) as ChildRow[]
            ).filter((c) => c.using_lifteracy).length,
          }
        : { type: 'class', school: subject.schoolName },
      time_last_7_days: topTime(week, names),
      time_yesterday: topTime(yesterday, names),
      tests: {
        nipun_grade_1: testFacts(g1, names),
        nipun_grade_2: testFacts(g2, names),
        nipun_grade_3: testFacts(g3, names),
        mpl_b: testFacts(mplB, names),
      },
      variety_seed: Math.floor(Math.random() * 1_000_000),
    };
    if (area) {
      facts.nipun_verdict = verdictFacts(verdict);
      facts.teachers = await this.teacherFacts(subject.entity.id, names);
    } else {
      facts.class = await this.classFacts(subject.teacherId, any);
      facts.share_link = '{{SHARE_LINK}}';
    }
    return facts;
  }

  // Teachers under the area with the most students, and how many they
  // enrolled this week (users.created_at — not on any results row).
  private async teacherFacts(
    areaId: string,
    names: Placeholders,
  ): Promise<Array<Record<string, unknown>>> {
    interface Row {
      id: string;
      name: string | null;
      school: string;
      students: number;
      new_this_week: number;
    }
    const rows: Row[] = await this.dataSource.query(
      `/* share-message:teachers */
       WITH RECURSIVE sub AS (
         SELECT id FROM geo_entity WHERE id = $1
         UNION ALL
         SELECT g.id FROM geo_entity g JOIN sub ON g.parent_id = sub.id WHERE g.deleted_at IS NULL
       )
       SELECT t.id, t.name, g.name AS school,
              count(s.id)::int AS students,
              count(s.id) FILTER (WHERE s.created_at > now() - interval '7 days')::int AS new_this_week
       FROM users t
       JOIN geo_entity g ON g.id = t.geo_entity_id AND g.type = 'school' AND g.deleted_at IS NULL
       JOIN sub ON sub.id = g.id
       LEFT JOIN users s ON s.referrer_user_id = t.id AND s.role = 'student' AND s.deleted_at IS NULL
       WHERE t.role = 'education_official' AND t.deleted_at IS NULL
       GROUP BY t.id, t.name, g.name
       HAVING count(s.id) > 0
       ORDER BY students DESC, new_this_week DESC
       LIMIT 5`,
      [areaId],
    );
    return rows.map((r) => ({
      who: names.add(`t:${r.id}`, r.name ?? 'शिक्षक'),
      school: r.school,
      students: r.students,
      enrolled_this_week: r.new_this_week,
    }));
  }

  private async classFacts(
    teacherId: string,
    any: ScoresResponse | null,
  ): Promise<Record<string, unknown>> {
    const rows: Array<{ students: number; new_this_week: number }> =
      await this.dataSource.query(
        `/* share-message:class */
       SELECT count(*)::int AS students,
              count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_this_week
       FROM users
       WHERE referrer_user_id = $1 AND role = 'student' AND deleted_at IS NULL`,
        [teacherId],
      );
    const students =
      any?.child_type === 'student' ? (any.children as StudentRow[]) : [];
    return {
      students: rows[0]?.students ?? students.length,
      enrolled_this_week: rows[0]?.new_this_week ?? 0,
      active_last_14_days: students.filter((s) => s.active).length,
    };
  }
}
