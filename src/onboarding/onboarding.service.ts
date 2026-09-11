import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createActor, type ActorRefFrom, type SnapshotFrom } from 'xstate';
import { UserService } from '../users/user.service';
import { LiteracyLessonService } from '../literacy/literacy-lesson/literacy-lesson.service';
import type { User } from '../users/user.dto';
import type { MediaMetaData } from '../media-meta-data/media-meta-data.dto';
import { OpenaiLlmService } from '../interfaces/llm/openai/openai-llm.service';
import { AnthropicLlmService } from '../interfaces/llm/anthropic/anthropic-llm.service';
import { GoogleLlmService } from '../interfaces/llm/google/google-llm.service';
import { MistralLlmService } from '../interfaces/llm/mistral/mistral-llm.service';
import { SarvamLlmService } from '../interfaces/llm/sarvam/sarvam-llm.service';
import type { LlmProvider } from '../interfaces/llm/llm.dto';
import { onboardingLlm } from './onboarding.config';
import { referralUrl } from '../interfaces/dashboard/dashboard-url';
import {
  machine,
  interpretFor,
  Interpret,
  ONBOARDING_STIDS,
  NONE,
  UNINTELLIGIBLE,
} from './onboarding.machine';

export interface HandleTurnOptions {
  user: User;
  // Absent on the very first turn (the row that starts onboarding needs no
  // classification) — a text first message has none.
  transcripts?: MediaMetaData[];
  user_message_id: string;
}

export interface HandleTurnResult {
  stateTransitionIds: string[];
  // Runtime text that has no media row (referral link, lesson-one passage);
  // the processor sends each as a text item after the stid media.
  texts: string[];
}

// One classification per turn, bounded so a parent's reply never waits on a
// slow provider: one attempt, 5 s. A failure fails the job; BullMQ's retry
// re-runs the whole turn (rollback + handleTurn).
const CLASSIFY_TIMEOUT_MS = 5000;
// Headroom for a chatty prefix ("The answer is: yes") — normalization below
// finds the answer inside it; at temperature 0 with a one-token target the
// extra budget is never spent.
const CLASSIFY_MAX_TOKENS = 200;
const NAME_MAX_LENGTH = 60;

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The one number in the text (Devanagari digits normalized — a Hindi
// transcript makes "८" a plausible reply); null when there are zero or
// several number tokens.
function singleNumberToken(text: string): number | null {
  const ascii = text.replace(/[०-९]/g, (d) =>
    String(DEVANAGARI_DIGITS.indexOf(d)),
  );
  const tokens = ascii.match(/\d+/g) ?? [];
  return tokens.length === 1 ? parseInt(tokens[0], 10) : null;
}

// Same URL the morning-update notifier uses (dashboard-url.ts).
export function referralText(externalId: string): string {
  return `PadhaiPal अपने दोस्तों के साथ शेयर करें बस उन्हें यह लिंक भेजें। ${referralUrl(externalId)}`;
}

// Calendar year in Asia/Kolkata — birth_year = this − the stated age.
export function istYear(now: Date = new Date()): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
    }).format(now),
    10,
  );
}

export function systemPrompt(interpret: Interpret): string {
  switch (interpret.kind) {
    case 'enum':
      return `Reply with exactly one of: ${interpret.options.join(', ')}. Transcripts of one reply from several speech engines follow. If none clearly matches, reply UNINTELLIGIBLE.`;
    case 'integer':
      return 'Reply with the integer only, or UNINTELLIGIBLE.';
    case 'month':
      return 'Reply with the month number 1–12, or NONE.';
    case 'name':
      return "Extract the person's name from these transcripts, in the script it appears in. Reply with the name only, or NONE.";
    case 'none':
      throw new Error('no classification for interpret kind none');
  }
}

// Collapses the model's free text onto the allowed set for the Interpret.
// Anything outside it is UNINTELLIGIBLE (month / name: NONE) — the machine
// never sees raw model output. Tolerant of a prefix or suffix ("The answer
// is yes", "I think 8") — an unnecessary UNINTELLIGIBLE costs a parent a
// whole retry turn — but never guesses between two candidates.
export function normalizeClassification(
  text: string,
  interpret: Interpret,
): string {
  const trimmed = text.trim();
  switch (interpret.kind) {
    case 'enum': {
      // Exactly one DISTINCT option present as a whole word: "yes yes" is
      // YES, "No, yes" is UNINTELLIGIBLE.
      const matched = new Set<string>();
      for (const option of interpret.options) {
        if (new RegExp(`\\b${escapeRegExp(option)}\\b`, 'i').test(trimmed)) {
          matched.add(option.toUpperCase());
        }
      }
      return matched.size === 1 ? [...matched][0] : UNINTELLIGIBLE;
    }
    case 'integer': {
      const n = singleNumberToken(trimmed);
      // Range is the machine's job (askAge retry), not the parser's.
      return n === null ? UNINTELLIGIBLE : String(n);
    }
    case 'month': {
      const month = singleNumberToken(trimmed);
      return month !== null && month >= 1 && month <= 12 ? String(month) : NONE;
    }
    case 'name': {
      const name = trimmed
        .replace(/^["'“”‘’]+/, '')
        .replace(/["'“”‘’.]+$/, '')
        .trim();
      if (
        name.length === 0 ||
        name.length > NAME_MAX_LENGTH ||
        /[\r\n]/.test(name) ||
        /^none$/i.test(name) ||
        /^unintelligible$/i.test(name)
      ) {
        return NONE;
      }
      return name;
    }
    case 'none':
      return 'ANY';
  }
}

interface StateRow {
  user_id: string;
  snapshot: Record<string, unknown>;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly userService: UserService,
    private readonly literacyLessonService: LiteracyLessonService,
    private readonly openaiLlmService: OpenaiLlmService,
    private readonly anthropicLlmService: AnthropicLlmService,
    private readonly googleLlmService: GoogleLlmService,
    private readonly mistralLlmService: MistralLlmService,
    private readonly sarvamLlmService: SarvamLlmService,
  ) {}

  // One onboarding turn. No row yet (or an unrestorable newest row): insert
  // the initial askGuardian snapshot and ask — no classification. Otherwise
  // classify the reply for the current state, run the machine, and persist
  // the new row; when the machine reaches `done`, the user's columns are
  // written in the same transaction and lesson one is started after commit.
  async handleTurn(options: HandleTurnOptions): Promise<HandleTurnResult> {
    const { user, transcripts, user_message_id } = options;

    const row = await this.findCurrentRow(user.id);
    const restored = row ? this.restore(user.id, row.snapshot) : null;

    if (!restored) {
      const actor = createActor(machine);
      actor.start();
      const stateTransitionIds = [
        ...actor.getSnapshot().context.stateTransitionIds,
      ];
      const snapshot = actor.getPersistedSnapshot();
      actor.stop();
      await this.dataSource.transaction(async (manager) => {
        await this.insertRow(manager, user.id, user_message_id, snapshot);
      });
      this.logger.log(
        `handleTurn: user ${user.id} started onboarding (${row ? 'restart' : 'first turn'})`,
      );
      return { stateTransitionIds, texts: [] };
    }

    const { actor, snapshot: current } = restored;
    if (current.status === 'done') {
      // Only reachable if the done turn's cache eviction was lost: the user
      // IS onboarded in the DB. Re-evict and nudge with the completion media
      // so the next turn lands in the lesson path.
      actor.stop();
      this.logger.error(
        `handleTurn: user ${user.id} already has a done onboarding row — re-evicting cache`,
      );
      await this.userService.invalidateCache(user);
      return { stateTransitionIds: [ONBOARDING_STIDS.complete], texts: [] };
    }

    const state = String(current.value);
    const interpret = interpretFor(current);
    const value =
      interpret.kind === 'none'
        ? 'ANY'
        : await this.classify(transcripts ?? [], interpret, state);

    actor.send({ type: 'REPLY', value, istYear: istYear() });
    const next = actor.getSnapshot();
    const persisted = actor.getPersistedSnapshot();
    actor.stop();

    const isDone = next.status === 'done';
    await this.dataSource.transaction(async (manager) => {
      await this.insertRow(manager, user.id, user_message_id, persisted);
      if (isDone) {
        await this.userService.update(
          {
            id: user.id,
            new_birth_year: next.context.birthYear,
            new_birth_month: next.context.birthMonth,
            new_recording_permissions_obtained_at: new Date(),
            ...(next.context.studentName !== null
              ? { new_name: next.context.studentName }
              : {}),
          },
          manager,
        );
      }
    });

    const stateTransitionIds = [...next.context.stateTransitionIds];
    const texts: string[] = [];
    this.logger.log(
      `handleTurn: user ${user.id} ${state} → ${String(next.value)} stids=[${stateTransitionIds.join(', ')}]`,
    );

    if (isDone) {
      await this.userService.invalidateCache(user);
      texts.push(referralText(user.external_id));
      const lesson = await this.literacyLessonService.processAnswer({
        user,
        user_message_id,
      });
      stateTransitionIds.push(...lesson.stateTransitionIds);
      if (lesson.sentenceText) texts.push(lesson.sentenceText);
    }

    return { stateTransitionIds, texts };
  }

  // Undo the row a previous attempt wrote for this message (BullMQ retry,
  // or wabot reporting delivered:false). A done row also undoes the user's
  // columns and the lesson-one rows started from it.
  async rollback(user_message_id: string): Promise<void> {
    const rows: StateRow[] = await this.dataSource.query(
      `DELETE FROM onboarding_states WHERE user_message_id = $1
       RETURNING user_id, snapshot`,
      [user_message_id],
    );
    const row = rows[0];
    if (!row) {
      this.logger.log(
        `rollback: no onboarding row for user_message_id=${user_message_id}`,
      );
      return;
    }
    const wasDone = row.snapshot?.status === 'done';
    if (wasDone) {
      await this.userService.update({
        id: row.user_id,
        new_birth_year: null,
        new_birth_month: null,
        new_recording_permissions_obtained_at: null,
      });
      await this.literacyLessonService.cleanupPartialState(user_message_id);
    }
    this.logger.log(
      `rollback: user_message_id=${user_message_id} row deleted done=${String(wasDone)}`,
    );
  }

  // Single completion, provider/model from env, temperature 0, all
  // transcripts in one message. Output is normalized onto the Interpret's
  // allowed set before it reaches the machine.
  async classify(
    transcripts: MediaMetaData[],
    interpret: Interpret,
    state = 'unknown',
  ): Promise<string> {
    const { provider, model } = onboardingLlm();
    const body = transcripts
      .map((t, i) => `Transcript ${i + 1}: ${(t.text ?? '').trim()}`)
      .join('\n');
    const result = await this.llmServiceFor(provider).complete(
      {
        model,
        messages: [
          { role: 'system', content: systemPrompt(interpret) },
          { role: 'user', content: body },
        ],
        temperatureRatio: 0,
        max_tokens: CLASSIFY_MAX_TOKENS,
      },
      { timeoutMs: CLASSIFY_TIMEOUT_MS, maxAttempts: 1 },
    );
    const value = normalizeClassification(result.text, interpret);
    // Names are PII — log only whether one was found.
    const outcome =
      interpret.kind === 'name' ? (value === NONE ? NONE : 'name') : value;
    this.logger.log(
      `onboarding.classify.result state=${state} kind=${interpret.kind} outcome=${outcome} provider=${provider} duration_ms=${result.duration_ms}`,
    );
    return value;
  }

  private async findCurrentRow(userId: string): Promise<StateRow | null> {
    const rows: StateRow[] = await this.dataSource.query(
      `SELECT user_id, snapshot FROM onboarding_states
       WHERE user_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [userId],
    );
    return rows[0] ?? null;
  }

  private async insertRow(
    manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    userId: string,
    userMessageId: string,
    snapshot: unknown,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO onboarding_states (user_id, user_message_id, snapshot, created_at)
       VALUES ($1, $2, $3, now())`,
      [userId, userMessageId, JSON.stringify(snapshot)],
    );
  }

  // A snapshot that no longer restores (machine shape changed, row
  // corrupted) must not crash-loop the job — it restarts onboarding.
  private restore(
    userId: string,
    snapshot: Record<string, unknown>,
  ): {
    actor: ActorRefFrom<typeof machine>;
    snapshot: SnapshotFrom<typeof machine>;
  } | null {
    try {
      const actor = createActor(machine, {
        snapshot: snapshot as unknown as SnapshotFrom<typeof machine>,
      });
      // An unobserved actor error is re-thrown by XState on a timer (an
      // uncaught exception that would take the worker down) — observe it so
      // it surfaces as the error status handled below instead.
      actor.subscribe({ error: () => undefined });
      actor.start();
      const snap = actor.getSnapshot();
      if (snap.status === 'error') {
        actor.stop();
        throw snap.error instanceof Error
          ? snap.error
          : new Error(String(snap.error));
      }
      return { actor, snapshot: snap };
    } catch (err) {
      this.logger.error(
        `restore failed for user ${userId}: ${(err as Error).message} — restarting onboarding`,
      );
      return null;
    }
  }

  private llmServiceFor(provider: LlmProvider) {
    switch (provider) {
      case 'openai':
        return this.openaiLlmService;
      case 'anthropic':
        return this.anthropicLlmService;
      case 'google':
        return this.googleLlmService;
      case 'mistral':
        return this.mistralLlmService;
      case 'sarvam':
        return this.sarvamLlmService;
    }
  }
}
