/**
 * Request validation + LLM-output parsing for the /media-meta-data/llm-generate
 * seeding pipeline.
 *
 * SECURITY: everything in `parseGeneratedContent` treats the LLM completion as
 * untrusted input. The rules:
 *  - never merge/spread parsed JSON into other objects — every accepted field
 *    is copied one-by-one into a fresh object (prototype-pollution-proof);
 *  - the LLM never supplies identifiers — passage/question/option/explanation
 *    ids and state_transition_ids are minted server-side (uuid);
 *  - the LLM never supplies the passage level — it is computed from word count
 *    (see passageLevelFromWordCount);
 *  - hard caps on size, counts and string lengths; control characters
 *    rejected (this text is sent to children over WhatsApp and into TTS).
 */
import { BadRequestException } from '@nestjs/common';
import {
  LlmMessage,
  LlmProvider,
  VALID_LLM_PROVIDERS,
} from '../interfaces/llm/llm.dto';

// ─── Comprehension state-transition-id helpers ───────────────────────────────
// Flow rows are stored under `${passageId}-sentence-comprehension`; the lesson
// machine emits `${passageId}-sentence-comprehension-correct-first|retry`, and
// findMediaByStateTransitionId maps the runtime stid back to the stored one
// (one flow per question, same flow regardless of first/retry). Explanation
// rows are stored under `${answerId}-comprehension-complete`, which is also
// the runtime stid. Note the prefixes are UUIDs (contain dashes), so the
// legacy `_`-generic-key derivation (split at first dash) does not apply to
// these ids — the regexes below are the source of truth.
export const SENTENCE_COMPREHENSION_STID_SUFFIX = 'sentence-comprehension';
export const COMPREHENSION_RUNTIME_STID_RE =
  /^(.+)-sentence-comprehension-correct-(?:first|retry)$/;
export const COMPREHENSION_COMPLETE_STID_SUFFIX = 'comprehension-complete';

export function comprehensionFlowStid(passageId: string): string {
  return `${passageId}-${SENTENCE_COMPREHENSION_STID_SUFFIX}`;
}

export function comprehensionCompleteStid(answerId: string): string {
  return `${answerId}-${COMPREHENSION_COMPLETE_STID_SUFFIX}`;
}

// ─── Limits ──────────────────────────────────────────────────────────────────

// WhatsApp Flow component caps (developers.facebook.com/docs/whatsapp/flows/
// reference/components): RadioButtonsGroup option description ≤ 300 chars
// (option titles are the fixed letters A–D), TextBody ≤ 4096. Enforced here
// at creation time and again at send time in wabot-sketch.
export const FLOW_OPTION_DESCRIPTION_MAX_CHARS = 300;
export const FLOW_QUESTION_MAX_CHARS = 1000;

const RAW_COMPLETION_MAX_CHARS = 100_000;
const PASSAGE_MAX_CHARS = 4096;
const EXPLANATION_MAX_CHARS = 4096;
const MAX_QUESTIONS = 10;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const REQUEST_MESSAGE_MAX_CHARS = 50_000;
const REQUEST_MAX_MESSAGES = 50;

// C0/C1 control chars except \n (allowed in passages). This content reaches
// children over WhatsApp and the ElevenLabs TTS pathway.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

export const VALID_QUESTION_TYPES = [
  'retrieve',
  'infer',
  'integrate',
  'interpret',
  'evaluate',
] as const;
export type QuestionType = (typeof VALID_QUESTION_TYPES)[number];

export const VALID_PASSAGE_TYPES = ['narrative', 'expository'] as const;
export type PassageType = (typeof VALID_PASSAGE_TYPES)[number];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LlmGenerateRequest {
  provider: LlmProvider;
  model: string;
  messages: LlmMessage[];
}

export interface GeneratedExplanation {
  text: string;
  tts: boolean;
}

export interface GeneratedOption {
  text: string;
  correct: boolean;
  explanation: GeneratedExplanation;
}

export interface GeneratedQuestion {
  text: string;
  question_type: QuestionType;
  send_as_flow: boolean;
  options: GeneratedOption[];
}

export interface GeneratedPassage {
  text: string;
  passage_type: PassageType;
  tts: boolean;
}

export interface GeneratedContent {
  passage: GeneratedPassage;
  questions: GeneratedQuestion[];
}

export interface LlmGenerateQuestionResult {
  status: 'created' | 'rejected';
  reason?: string;
  question_id?: string;
  solvability_rate?: number;
}

export interface LlmGenerateResponse {
  status: 'created' | 'rejected' | 'failed';
  /** Present when status !== 'created'. */
  reason?: string;
  /** Whether retrying the same request may help (LLM/network flakiness). */
  retriable?: boolean;
  passage_id?: string;
  level?: number;
  questions?: LlmGenerateQuestionResult[];
  /** Set when text entities were created but TTS enqueue failed. */
  tts_error?: string;
}

/**
 * Thrown when the completion came back but its content failed validation —
 * distinguishes "the LLM produced bad JSON" (status 'rejected', retriable:
 * a fresh sample may pass) from transport failures (status 'failed').
 */
export class LlmOutputInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmOutputInvalidError';
  }
}

// ─── Request validation ──────────────────────────────────────────────────────

export function validateLlmGenerateRequest(body: unknown): LlmGenerateRequest {
  if (!body || typeof body !== 'object') {
    throw new BadRequestException('llm-generate body must be an object');
  }
  const raw = body as Record<string, unknown>;

  const provider = raw.provider;
  if (
    typeof provider !== 'string' ||
    !(VALID_LLM_PROVIDERS as readonly string[]).includes(provider)
  ) {
    throw new BadRequestException(
      `provider must be one of: ${VALID_LLM_PROVIDERS.join(', ')}`,
    );
  }

  const model = raw.model;
  if (typeof model !== 'string' || model.length === 0 || model.length > 200) {
    throw new BadRequestException('model must be a 1-200 char string');
  }

  const messages = raw.messages;
  if (
    !Array.isArray(messages) ||
    messages.length === 0 ||
    messages.length > REQUEST_MAX_MESSAGES
  ) {
    throw new BadRequestException(
      `messages must be an array of 1-${REQUEST_MAX_MESSAGES} items`,
    );
  }
  const validated: LlmMessage[] = messages.map((m, i) => {
    if (!m || typeof m !== 'object') {
      throw new BadRequestException(`messages[${i}] must be an object`);
    }
    const { role, content } = m as Record<string, unknown>;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      throw new BadRequestException(
        `messages[${i}].role must be system|user|assistant`,
      );
    }
    if (
      typeof content !== 'string' ||
      content.length === 0 ||
      content.length > REQUEST_MESSAGE_MAX_CHARS
    ) {
      throw new BadRequestException(
        `messages[${i}].content must be a 1-${REQUEST_MESSAGE_MAX_CHARS} char string`,
      );
    }
    return { role, content };
  });

  return { provider: provider as LlmProvider, model, messages: validated };
}

// ─── LLM output parsing ──────────────────────────────────────────────────────

function requireCleanString(
  value: unknown,
  field: string,
  maxChars: number,
): string {
  if (typeof value !== 'string') {
    throw new LlmOutputInvalidError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new LlmOutputInvalidError(`${field} must not be empty`);
  }
  if (trimmed.length > maxChars) {
    throw new LlmOutputInvalidError(
      `${field} exceeds ${maxChars} chars (got ${trimmed.length})`,
    );
  }
  if (CONTROL_CHARS_RE.test(trimmed)) {
    throw new LlmOutputInvalidError(`${field} contains control characters`);
  }
  return trimmed;
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Parses a raw chat completion into validated GeneratedContent. Tolerates a
 * ```json fenced block around the object (common LLM habit), nothing else.
 */
export function parseGeneratedContent(raw: string): GeneratedContent {
  if (raw.length > RAW_COMPLETION_MAX_CHARS) {
    throw new LlmOutputInvalidError(
      `completion exceeds ${RAW_COMPLETION_MAX_CHARS} chars`,
    );
  }
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(raw);
  const jsonText = fenced ? fenced[1] : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new LlmOutputInvalidError(
      `completion is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LlmOutputInvalidError('completion must be a JSON object');
  }
  const root = parsed as Record<string, unknown>;

  const rawPassage = root.passage;
  if (!rawPassage || typeof rawPassage !== 'object') {
    throw new LlmOutputInvalidError('passage must be an object');
  }
  const passageRecord = rawPassage as Record<string, unknown>;
  const passageType = passageRecord.passage_type;
  if (
    typeof passageType !== 'string' ||
    !(VALID_PASSAGE_TYPES as readonly string[]).includes(passageType)
  ) {
    throw new LlmOutputInvalidError(
      `passage.passage_type must be one of: ${VALID_PASSAGE_TYPES.join(', ')}`,
    );
  }
  const passage: GeneratedPassage = {
    text: requireCleanString(
      passageRecord.text,
      'passage.text',
      PASSAGE_MAX_CHARS,
    ),
    passage_type: passageType as PassageType,
    tts: optionalBoolean(passageRecord.tts, false),
  };

  const rawQuestions = root.questions;
  if (
    !Array.isArray(rawQuestions) ||
    rawQuestions.length === 0 ||
    rawQuestions.length > MAX_QUESTIONS
  ) {
    throw new LlmOutputInvalidError(
      `questions must be an array of 1-${MAX_QUESTIONS} items`,
    );
  }

  const questions: GeneratedQuestion[] = rawQuestions.map((q, qi) => {
    if (!q || typeof q !== 'object') {
      throw new LlmOutputInvalidError(`questions[${qi}] must be an object`);
    }
    const questionRecord = q as Record<string, unknown>;
    const questionType = questionRecord.question_type;
    if (
      typeof questionType !== 'string' ||
      !(VALID_QUESTION_TYPES as readonly string[]).includes(questionType)
    ) {
      throw new LlmOutputInvalidError(
        `questions[${qi}].question_type must be one of: ${VALID_QUESTION_TYPES.join(', ')}`,
      );
    }

    const rawOptions = questionRecord.options;
    if (
      !Array.isArray(rawOptions) ||
      rawOptions.length < MIN_OPTIONS ||
      rawOptions.length > MAX_OPTIONS
    ) {
      throw new LlmOutputInvalidError(
        `questions[${qi}].options must have ${MIN_OPTIONS}-${MAX_OPTIONS} items`,
      );
    }

    const options: GeneratedOption[] = rawOptions.map((o, oi) => {
      if (!o || typeof o !== 'object') {
        throw new LlmOutputInvalidError(
          `questions[${qi}].options[${oi}] must be an object`,
        );
      }
      const optionRecord = o as Record<string, unknown>;
      const rawExplanation = optionRecord.explanation;
      if (!rawExplanation || typeof rawExplanation !== 'object') {
        throw new LlmOutputInvalidError(
          `questions[${qi}].options[${oi}].explanation must be an object`,
        );
      }
      const explanationRecord = rawExplanation as Record<string, unknown>;
      return {
        text: requireCleanString(
          optionRecord.text,
          `questions[${qi}].options[${oi}].text`,
          FLOW_OPTION_DESCRIPTION_MAX_CHARS,
        ),
        correct: optionalBoolean(optionRecord.correct, false),
        explanation: {
          text: requireCleanString(
            explanationRecord.text,
            `questions[${qi}].options[${oi}].explanation.text`,
            EXPLANATION_MAX_CHARS,
          ),
          tts: optionalBoolean(explanationRecord.tts, false),
        },
      };
    });

    const correctCount = options.filter((o) => o.correct).length;
    if (correctCount !== 1) {
      throw new LlmOutputInvalidError(
        `questions[${qi}] must have exactly one correct option (got ${correctCount})`,
      );
    }

    return {
      text: requireCleanString(
        questionRecord.text,
        `questions[${qi}].text`,
        FLOW_QUESTION_MAX_CHARS,
      ),
      question_type: questionType as QuestionType,
      send_as_flow: optionalBoolean(questionRecord.send_as_flow, true),
      options,
    };
  });

  return { passage, questions };
}

// ─── Passage level ───────────────────────────────────────────────────────────

// Same separator class the lesson uses (splitLessonWords in
// literacy-lesson.service.ts).
const WORD_SEPARATORS_RE = /[\s।॥,.!?;:'"“”‘’()[\]{}\-–—~]+/u;

/**
 * Level is computed from word count, never trusted from the LLM:
 * <10 words → 8, <40 → 9, <70 → 10, <110 → 11, else 12.
 */
export function passageLevelFromWordCount(text: string): number {
  const wordCount = text
    .split(WORD_SEPARATORS_RE)
    .filter((w) => w.length > 0).length;
  if (wordCount < 10) return 8;
  if (wordCount < 40) return 9;
  if (wordCount < 70) return 10;
  if (wordCount < 110) return 11;
  return 12;
}

// ─── Flow payload (media_metadata.text of media_type='flow' rows) ────────────

/**
 * Stored at creation, consumed at send time by the inbound processor, which
 * shuffles the options and assigns the A–D titles per send. Option ids are
 * the option entities' media_metadata ids, so the nfm_reply hands back the
 * selected answer id directly.
 */
export interface FlowMediaPayload {
  question_text: string;
  options: Array<{ id: string; text: string; correct: boolean }>;
}
