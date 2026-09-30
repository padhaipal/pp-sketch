import { createActor } from 'xstate';
import { machine } from './onboarding.machine';
import {
  describeOnboardingTurns,
  type OnboardingTurnRow,
} from './onboarding-turns';

// Drives the REAL machine so the read-side derivation can never drift from
// the transitions it describes: each reply becomes one persisted row, exactly
// as OnboardingService.handleTurn writes them.
function rowsFor(
  replies: string[],
  at = '2026-09-20T08:00:00Z',
): OnboardingTurnRow[] {
  const actor = createActor(machine);
  actor.start();
  const rows: OnboardingTurnRow[] = [
    {
      user_message_id: 'm0',
      snapshot: actor.getPersistedSnapshot() as Record<string, unknown>,
      created_at: at,
    },
  ];
  replies.forEach((value, i) => {
    actor.send({ type: 'REPLY', value, istYear: 2026 });
    rows.push({
      user_message_id: `m${i + 1}`,
      snapshot: actor.getPersistedSnapshot() as Record<string, unknown>,
      created_at: at,
    });
  });
  actor.stop();
  return rows;
}

describe('describeOnboardingTurns', () => {
  it('the happy path: every turn is described, values are held until the completing turn', () => {
    const turns = describeOnboardingTurns(
      rowsFor(['YES', 'YES', 'आशा', '8', '3']),
    );
    expect([...turns.values()]).toEqual([
      // first message: onboarding starts, nothing is interpreted
      {
        question: null,
        next: 'askGuardian',
        understood: null,
        saved: [],
        completed: false,
      },
      {
        question: 'askGuardian',
        next: 'askConsent',
        understood: 'YES',
        saved: [],
        completed: false,
      },
      {
        question: 'askConsent',
        next: 'askName',
        understood: 'YES',
        saved: [],
        completed: false,
      },
      {
        question: 'askName',
        next: 'askAge',
        understood: 'आशा',
        saved: [{ field: 'name', value: 'आशा' }],
        completed: false,
      },
      {
        question: 'askAge',
        next: 'askMonth',
        understood: '8',
        saved: [{ field: 'birth_year', value: '2018' }],
        completed: false,
      },
      {
        question: 'askMonth',
        next: 'done',
        understood: '3',
        saved: [{ field: 'birth_month', value: '3' }],
        completed: true,
      },
    ]);
    expect([...turns.keys()]).toEqual(['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('guardian: NO repeats the question, an unclear reply is UNINTELLIGIBLE', () => {
    const turns = [
      ...describeOnboardingTurns(rowsFor(['NO', 'UNINTELLIGIBLE'])).values(),
    ];
    expect(turns[1]).toEqual(
      expect.objectContaining({
        question: 'askGuardian',
        next: 'askGuardian',
        understood: 'NO',
      }),
    );
    expect(turns[2]).toEqual(
      expect.objectContaining({
        question: 'askGuardian',
        next: 'askGuardian',
        understood: 'UNINTELLIGIBLE',
      }),
    );
  });

  it('consent: INFORMATION, NO → refused → YES re-asks / NO declines; a declined parent re-opens consent with any reply', () => {
    const turns = [
      ...describeOnboardingTurns(
        rowsFor(['YES', 'INFORMATION', 'NO', 'YES', 'NO', 'NO', 'ANY']),
      ).values(),
    ].map((t) => [t.question, t.next, t.understood]);
    expect(turns.slice(2)).toEqual([
      ['askConsent', 'askConsent', 'INFORMATION'],
      ['askConsent', 'consentRefused', 'NO'],
      ['consentRefused', 'askConsent', 'YES'],
      ['askConsent', 'consentRefused', 'NO'],
      ['consentRefused', 'declined', 'NO'],
      // declined: nothing is read — any voice note re-opens the question
      ['declined', 'askConsent', null],
    ]);
  });

  it('no name / unreadable age / no month', () => {
    const turns = [
      ...describeOnboardingTurns(
        rowsFor(['YES', 'YES', 'NONE', 'UNINTELLIGIBLE', '7', 'NONE']),
      ).values(),
    ];
    expect(turns[3]).toEqual({
      question: 'askName',
      next: 'askAge',
      understood: 'NONE',
      saved: [],
      completed: false,
    });
    expect(turns[4]).toEqual({
      question: 'askAge',
      next: 'askAge',
      understood: 'UNINTELLIGIBLE',
      saved: [],
      completed: false,
    });
    expect(turns[5].understood).toBe('7');
    expect(turns[6]).toEqual({
      question: 'askMonth',
      next: 'done',
      understood: 'NONE',
      saved: [],
      completed: true,
    });
  });

  it('age is recovered from the IST year of the turn (23:00 UTC on 31 Dec is already the next year in India)', () => {
    const rows = rowsFor(['YES', 'YES', 'NONE', '8']);
    // machine was driven with istYear 2026 → birthYear 2018
    rows[4].created_at = new Date('2025-12-31T23:00:00Z'); // IST: 2026-01-01
    expect(describeOnboardingTurns(rows).get('m4')!.understood).toBe('8');
  });

  it('a restart row (unrestorable snapshot → fresh askGuardian) is a start, not a NO', () => {
    const rows = rowsFor(['YES']);
    rows.push({ ...rowsFor([])[0], user_message_id: 'restart' });
    expect(describeOnboardingTurns(rows).get('restart')).toEqual({
      question: null,
      next: 'askGuardian',
      understood: null,
      saved: [],
      completed: false,
    });
  });

  it('tolerates malformed snapshots', () => {
    const turns = describeOnboardingTurns([
      { user_message_id: 'a', snapshot: null, created_at: '2026-09-20' },
      {
        user_message_id: 'b',
        snapshot: {
          value: { nested: true },
          context: { stateTransitionIds: 'x' },
        },
        created_at: '2026-09-20',
      },
      {
        user_message_id: 'c',
        snapshot: {
          value: 'askAge',
          context: { stateTransitionIds: [1, 'onboarding-ask-age'] },
        },
        created_at: '2026-09-20',
      },
    ]);
    expect(turns.get('a')).toEqual({
      question: null,
      next: null,
      understood: null,
      saved: [],
      completed: false,
    });
    expect(turns.get('b')!.question).toBeNull();
    // prev state unknown (null) → nothing can be inferred
    expect(turns.get('c')).toEqual({
      question: null,
      next: 'askAge',
      understood: null,
      saved: [],
      completed: false,
    });
    expect(describeOnboardingTurns([]).size).toBe(0);
  });
});
