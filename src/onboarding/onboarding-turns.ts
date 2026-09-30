import { istDateIso } from '../notifier/report-card/report-card.utils';
import { NONE, ONBOARDING_STIDS, UNINTELLIGIBLE } from './onboarding.machine';

// Pure read-side description of a user's onboarding turns for the staff
// /user/:id page. `onboarding_states` stores only the snapshot AFTER each
// turn — the classifier's reading of the parent's reply is logged, never
// persisted — so what a turn was taken to mean, and what it added to the
// record, is derived here from each row and the one before it. Works for
// every historical row; no schema change.

export interface OnboardingTurnRow {
  user_message_id: string;
  snapshot: Record<string, unknown> | null;
  created_at: Date | string;
}

export type OnboardingSavedField = 'name' | 'birth_year' | 'birth_month';

export interface OnboardingTurn {
  // The question the parent was answering = the machine state BEFORE this
  // turn. Null on a row that started (or restarted) onboarding: nothing is
  // interpreted there, the first question is just asked.
  question: string | null;
  // The machine state after the turn (`done` once complete).
  next: string | null;
  // What the reply was taken to mean: YES / NO / INFORMATION /
  // UNINTELLIGIBLE, the age in whole years, the month number, the name, or
  // NONE (no name / no month heard). Null when nothing was interpreted.
  understood: string | null;
  // What this turn added to the onboarding record. It is held there and
  // reaches the user's own columns only on the completing turn.
  saved: { field: OnboardingSavedField; value: string }[];
  // The turn that completed onboarding: birth year, birth month, the
  // recording-permission timestamp and (when one was heard) the name were
  // written to the user in the same transaction.
  completed: boolean;
}

interface SnapshotView {
  value: string | null;
  done: boolean;
  stids: string[];
  studentName: string | null;
  birthYear: number | null;
  birthMonth: number | null;
}

function view(snapshot: Record<string, unknown> | null): SnapshotView {
  const context = (snapshot?.context ?? {}) as Record<string, unknown>;
  const stids = context.stateTransitionIds;
  return {
    value: typeof snapshot?.value === 'string' ? snapshot.value : null,
    done: snapshot?.status === 'done',
    stids: Array.isArray(stids)
      ? stids.filter((s): s is string => typeof s === 'string')
      : [],
    studentName:
      typeof context.studentName === 'string' ? context.studentName : null,
    birthYear: typeof context.birthYear === 'number' ? context.birthYear : null,
    birthMonth:
      typeof context.birthMonth === 'number' ? context.birthMonth : null,
  };
}

// The initial snapshot (first turn, or a restart after an unrestorable row):
// askGuardian with exactly its own prompt stid. A NO there emits
// `-ask-guardian-retry` and an unintelligible reply emits two stids, so
// neither can be mistaken for it.
function isStartRow(cur: SnapshotView): boolean {
  return (
    cur.value === 'askGuardian' &&
    cur.stids.length === 1 &&
    cur.stids[0] === ONBOARDING_STIDS.askGuardian
  );
}

function describe(
  prev: SnapshotView | null,
  cur: SnapshotView,
  createdAt: Date,
): OnboardingTurn {
  const turn: OnboardingTurn = {
    question: null,
    next: cur.value,
    understood: null,
    saved: [],
    completed: cur.done,
  };
  if (!prev || isStartRow(cur)) return turn;
  turn.question = prev.value;
  if (cur.stids[0] === ONBOARDING_STIDS.unintelligible) {
    turn.understood = UNINTELLIGIBLE;
    return turn;
  }
  switch (prev.value) {
    case 'askGuardian':
      turn.understood = cur.value === 'askConsent' ? 'YES' : 'NO';
      break;
    case 'askConsent':
      turn.understood =
        cur.value === 'askName'
          ? 'YES'
          : cur.value === 'consentRefused'
            ? 'NO'
            : 'INFORMATION';
      break;
    case 'consentRefused':
      turn.understood = cur.value === 'askConsent' ? 'YES' : 'NO';
      break;
    case 'askName':
      turn.understood = cur.studentName ?? NONE;
      if (cur.studentName !== null) {
        turn.saved.push({ field: 'name', value: cur.studentName });
      }
      break;
    case 'askAge':
      if (cur.birthYear !== null) {
        // birthYear = (IST year of the turn) − age, so the age is recovered
        // from the row's own timestamp.
        const istYear = parseInt(istDateIso(createdAt).slice(0, 4), 10);
        turn.understood = String(istYear - cur.birthYear);
        turn.saved.push({ field: 'birth_year', value: String(cur.birthYear) });
      }
      break;
    case 'askMonth':
      turn.understood = cur.birthMonth !== null ? String(cur.birthMonth) : NONE;
      if (cur.birthMonth !== null) {
        turn.saved.push({
          field: 'birth_month',
          value: String(cur.birthMonth),
        });
      }
      break;
    // declined: any reply re-opens the consent question — nothing is read.
  }
  return turn;
}

// `rowsOldestFirst`: every onboarding_states row of ONE user, oldest first.
export function describeOnboardingTurns(
  rowsOldestFirst: readonly OnboardingTurnRow[],
): Map<string, OnboardingTurn> {
  const out = new Map<string, OnboardingTurn>();
  let prev: SnapshotView | null = null;
  for (const row of rowsOldestFirst) {
    const cur = view(row.snapshot);
    out.set(row.user_message_id, describe(prev, cur, new Date(row.created_at)));
    prev = cur;
  }
  return out;
}
