import { createHash } from 'node:crypto';
import { maskPii } from './pii-mask';
import { censorTranscript } from './transcript-censor';

// The donor page's live stream of student interactions (GET
// users/dashboard/interactions): the most recent turns across every
// onboarded student, shaped for the general public. Pure — the SQL lives in
// interaction-stream.service.ts.
//
// What a member of the public sees per turn: the student's name masked
// ("R...i"; a stand-in "A...l" when unnamed), when, voice note or tap, what they answered, the expected
// answer, whether it was marked correct, reading speed. A voice answer is
// the transcript run through censorTranscript and then masked to its first
// and last character — what a child said is never shown in full. No audio,
// no user or media ids (the row key is a hash), no school or place.

// at most this many turns per response, newest first
export const INTERACTION_STREAM_LIMIT = 20;
// a turn is only published once it is this old (enforced in SQL)
export const INTERACTION_STREAM_DELAY_S = 120;

// which engine's transcript stands for a voice note, first non-empty wins
const TRANSCRIPT_PREFERENCE = ['sarvam', 'azure', 'bodhan', 'reverie'];

// An unnamed student (most were onboarded before names were asked) gets a
// stand-in in the same masked shape, "A...l": an upper- and a lower-case
// letter from a hash of their id — stable, so the same child is
// recognisable down the stream, and not derived from anything personal.
export const studentInitials = (userId: string): string => {
  const h = createHash('sha256').update(`student:${userId}`).digest();
  const letter = (byte: number, base: number) =>
    String.fromCharCode(base + (byte % 26));
  return maskPii(`${letter(h[0], 65)}${letter(h[1], 97)}`);
};

export interface InteractionStreamRow {
  key: string; // opaque, stable per turn
  at: string; // ISO timestamp of the student's message
  student: string; // masked name, or a stand-in "A...l" when unnamed
  kind: 'voice' | 'tap';
  answer: string | null; // masked transcript, or the tapped option
  correct_answer: string | null;
  answer_correct: boolean | null;
  wpm: number | null;
}

export interface InteractionStreamResponse {
  computed_at: string;
  delay_s: number;
  rows: InteractionStreamRow[];
}

// one turn as read from the database
export interface InteractionSourceRow {
  id: string;
  user_id: string;
  created_at: Date | string;
  media_type: string;
  duration_ms: number | string | null;
  student_name: string | null;
  // lesson state written for this message (first, evaluation row)
  lesson_word: string | null;
  lesson_answer_correct: boolean | null;
  // the student's previous lesson state (its evaluation row) and whether a
  // tap ended a lesson in between
  prev_word: string | null;
  prev_answer: string | null;
  tap_between: boolean | null;
  // taps: the chosen option and the question's correct option
  tap_chosen: string | null;
  tap_chosen_correct: boolean | null;
  tap_correct: string | null;
  transcripts: { source: string | null; text: string | null }[] | null;
}

export const rowKey = (mediaId: string): string =>
  createHash('sha256').update(mediaId).digest('hex').slice(0, 16);

export function pickTranscript(
  transcripts: InteractionSourceRow['transcripts'],
): string | null {
  const usable = (transcripts ?? []).filter(
    (t) => typeof t.text === 'string' && t.text.trim().length > 0,
  );
  if (usable.length === 0) return null;
  const rank = (s: string | null) => {
    const i = TRANSCRIPT_PREFERENCE.indexOf(s ?? '');
    return i === -1 ? TRANSCRIPT_PREFERENCE.length : i;
  };
  usable.sort((a, b) => rank(a.source) - rank(b.source));
  return usable[0].text;
}

// The expected answer as /user/:id shows it: the lesson's answer column
// holds the answer for the NEXT state, so a turn displays the previous
// turn's answer while the same word continues, and the word itself when a
// new word starts (or after a tap ended the lesson).
export function displayedAnswer(r: InteractionSourceRow): string | null {
  if (r.lesson_word === null) return null;
  if (r.prev_word === null || r.tap_between || r.prev_word !== r.lesson_word)
    return r.lesson_word;
  return r.prev_answer;
}

// Words per minute for passage reads (a lesson word of 2+ tokens), from the
// voice note's measured length — as /user/:id.
export function wpmOf(r: InteractionSourceRow): number | null {
  const words = (r.lesson_word ?? '').split(/\s+/).filter(Boolean).length;
  const ms = r.duration_ms === null ? null : Number(r.duration_ms);
  if (words < 2 || ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(words / (ms / 60_000));
}

export function toStreamRow(r: InteractionSourceRow): InteractionStreamRow {
  const tap = r.media_type === 'text';
  const transcript = tap ? null : pickTranscript(r.transcripts);
  return {
    key: rowKey(r.id),
    at: new Date(r.created_at).toISOString(),
    student: r.student_name?.trim()
      ? maskPii(r.student_name)
      : studentInitials(r.user_id),
    kind: tap ? 'tap' : 'voice',
    answer: tap
      ? r.tap_chosen
      : transcript === null
        ? null
        : maskPii(censorTranscript(transcript, [r.student_name]).text),
    correct_answer: tap ? r.tap_correct : displayedAnswer(r),
    answer_correct: tap
      ? (r.tap_chosen_correct ?? r.lesson_answer_correct)
      : r.lesson_answer_correct,
    wpm: tap ? null : wpmOf(r),
  };
}
