import { createActor, type ActorRefFrom } from 'xstate';
import {
  machine,
  interpretFor,
  ONBOARDING_STIDS,
  UNINTELLIGIBLE,
  NONE,
  MIN_AGE,
  MAX_AGE,
  type OnboardingStateName,
} from './onboarding.machine';

const IST_YEAR = 2026;

function start(): ActorRefFrom<typeof machine> {
  const actor = createActor(machine);
  actor.start();
  return actor;
}

function reply(actor: ActorRefFrom<typeof machine>, value: string) {
  actor.send({ type: 'REPLY', value, istYear: IST_YEAR });
  return actor.getSnapshot();
}

// Drives a fresh actor to the named state along the happy path.
const PATH_TO: Record<OnboardingStateName, string[]> = {
  askGuardian: [],
  askConsent: ['YES'],
  consentRefused: ['YES', 'NO'],
  declined: ['YES', 'NO', 'NO'],
  askName: ['YES', 'YES'],
  askAge: ['YES', 'YES', 'राम'],
  askMonth: ['YES', 'YES', 'राम', '8'],
  done: ['YES', 'YES', 'राम', '8', '3'],
};

function at(state: OnboardingStateName): ActorRefFrom<typeof machine> {
  const actor = start();
  for (const value of PATH_TO[state]) reply(actor, value);
  expect(actor.getSnapshot().value).toBe(state);
  return actor;
}

describe('onboarding machine — initial state', () => {
  it('starts in askGuardian with its prompt stid and empty answers', () => {
    const snap = start().getSnapshot();
    expect(snap.value).toBe('askGuardian');
    expect(snap.context).toEqual({
      stateTransitionIds: [ONBOARDING_STIDS.askGuardian],
      birthYear: null,
      birthMonth: null,
      studentName: null,
    });
  });
});

describe('onboarding machine — meta.interpret per state', () => {
  it.each<[OnboardingStateName, unknown]>([
    ['askGuardian', { kind: 'enum', options: ['yes', 'no'] }],
    ['askConsent', { kind: 'enum', options: ['yes', 'no', 'information'] }],
    ['consentRefused', { kind: 'enum', options: ['yes', 'no'] }],
    ['declined', { kind: 'none' }],
    ['askName', { kind: 'name' }],
    ['askAge', { kind: 'integer', min: MIN_AGE, max: MAX_AGE }],
    ['askMonth', { kind: 'month' }],
    ['done', { kind: 'none' }],
  ])('%s declares %j', (state, interpret) => {
    expect(interpretFor(at(state).getSnapshot())).toEqual(interpret);
  });

  it('throws for a state without meta', () => {
    expect(() => interpretFor({ value: 'nope', getMeta: () => ({}) })).toThrow(
      /declares no meta.interpret/,
    );
  });
});

describe('onboarding machine — askGuardian', () => {
  it('YES → askConsent, emitting only the consent prompt', () => {
    const snap = reply(at('askGuardian'), 'YES');
    expect(snap.value).toBe('askConsent');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.askConsent,
    ]);
  });

  it('NO → stays, emitting the retry prompt', () => {
    const snap = reply(at('askGuardian'), 'NO');
    expect(snap.value).toBe('askGuardian');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.askGuardianRetry,
    ]);
  });

  it('UNINTELLIGIBLE → stays, emitting unintelligible + its own prompt', () => {
    const snap = reply(at('askGuardian'), UNINTELLIGIBLE);
    expect(snap.value).toBe('askGuardian');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.unintelligible,
      ONBOARDING_STIDS.askGuardian,
    ]);
  });
});

describe('onboarding machine — askConsent', () => {
  it('YES → askName', () => {
    const snap = reply(at('askConsent'), 'YES');
    expect(snap.value).toBe('askName');
    expect(snap.context.stateTransitionIds).toEqual([ONBOARDING_STIDS.askName]);
  });

  it('INFORMATION → stays, emitting consent-info', () => {
    const snap = reply(at('askConsent'), 'INFORMATION');
    expect(snap.value).toBe('askConsent');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.consentInfo,
    ]);
  });

  it('NO → consentRefused', () => {
    const snap = reply(at('askConsent'), 'NO');
    expect(snap.value).toBe('consentRefused');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.consentRefused,
    ]);
  });

  it('UNINTELLIGIBLE → stays, emitting unintelligible + its own prompt', () => {
    const snap = reply(at('askConsent'), UNINTELLIGIBLE);
    expect(snap.value).toBe('askConsent');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.unintelligible,
      ONBOARDING_STIDS.askConsent,
    ]);
  });
});

describe('onboarding machine — consentRefused', () => {
  it('YES → back to askConsent with the info media (not the plain prompt)', () => {
    const snap = reply(at('consentRefused'), 'YES');
    expect(snap.value).toBe('askConsent');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.consentInfo,
    ]);
  });

  it('NO → declined', () => {
    const snap = reply(at('consentRefused'), 'NO');
    expect(snap.value).toBe('declined');
    expect(snap.status).toBe('active');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.declined,
    ]);
  });

  it('UNINTELLIGIBLE → stays, emitting unintelligible + its own prompt', () => {
    const snap = reply(at('consentRefused'), UNINTELLIGIBLE);
    expect(snap.value).toBe('consentRefused');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.unintelligible,
      ONBOARDING_STIDS.consentRefused,
    ]);
  });
});

describe('onboarding machine — declined', () => {
  it('is not final and any reply re-opens askConsent', () => {
    const actor = at('declined');
    expect(actor.getSnapshot().status).toBe('active');
    const snap = reply(actor, 'ANY');
    expect(snap.value).toBe('askConsent');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.askConsent,
    ]);
  });
});

describe('onboarding machine — askName', () => {
  it('stores the extracted name and advances to askAge', () => {
    const snap = reply(at('askName'), 'सीता');
    expect(snap.value).toBe('askAge');
    expect(snap.context.studentName).toBe('सीता');
    expect(snap.context.stateTransitionIds).toEqual([ONBOARDING_STIDS.askAge]);
  });

  it('NONE advances with a null name — never UNINTELLIGIBLE', () => {
    const snap = reply(at('askName'), NONE);
    expect(snap.value).toBe('askAge');
    expect(snap.context.studentName).toBeNull();
    expect(snap.context.stateTransitionIds).toEqual([ONBOARDING_STIDS.askAge]);
  });
});

describe('onboarding machine — askAge', () => {
  it.each([String(MIN_AGE), '8', String(MAX_AGE)])(
    'valid age %s → askMonth with birthYear = IST year − age',
    (age) => {
      const snap = reply(at('askAge'), age);
      expect(snap.value).toBe('askMonth');
      expect(snap.context.birthYear).toBe(IST_YEAR - parseInt(age, 10));
      expect(snap.context.stateTransitionIds).toEqual([
        ONBOARDING_STIDS.askMonth,
      ]);
    },
  );

  it.each([String(MIN_AGE - 1), String(MAX_AGE + 1), '0', '120'])(
    'out-of-range age %s → stays, emitting the age retry prompt',
    (age) => {
      const snap = reply(at('askAge'), age);
      expect(snap.value).toBe('askAge');
      expect(snap.context.birthYear).toBeNull();
      expect(snap.context.stateTransitionIds).toEqual([
        ONBOARDING_STIDS.askAgeRetry,
      ]);
    },
  );

  it('UNINTELLIGIBLE → stays, emitting unintelligible + its own prompt', () => {
    const snap = reply(at('askAge'), UNINTELLIGIBLE);
    expect(snap.value).toBe('askAge');
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.unintelligible,
      ONBOARDING_STIDS.askAge,
    ]);
  });
});

describe('onboarding machine — askMonth → done', () => {
  it.each([
    ['1', 1],
    ['7', 7],
    ['12', 12],
  ])('month %s completes with birthMonth %i', (value, month) => {
    const snap = reply(at('askMonth'), value);
    expect(snap.value).toBe('done');
    expect(snap.status).toBe('done');
    expect(snap.context.birthMonth).toBe(month);
    expect(snap.context.stateTransitionIds).toEqual([
      ONBOARDING_STIDS.complete,
    ]);
  });

  it.each([NONE, '0', '13', 'UNINTELLIGIBLE'])(
    '%s completes with a null birthMonth',
    (value) => {
      const snap = reply(at('askMonth'), value);
      expect(snap.status).toBe('done');
      expect(snap.context.birthMonth).toBeNull();
    },
  );

  it('done keeps every answer gathered on the way', () => {
    const snap = at('done').getSnapshot();
    expect(snap.context).toEqual({
      stateTransitionIds: [ONBOARDING_STIDS.complete],
      birthYear: IST_YEAR - 8,
      birthMonth: 3,
      studentName: 'राम',
    });
  });
});

describe('onboarding machine — persistence round trip', () => {
  it('restores a persisted snapshot and continues from the same state', () => {
    const first = at('askAge');
    const persisted = JSON.parse(JSON.stringify(first.getPersistedSnapshot()));
    first.stop();

    const restored = createActor(machine, { snapshot: persisted });
    restored.start();
    expect(restored.getSnapshot().value).toBe('askAge');
    expect(interpretFor(restored.getSnapshot()).kind).toBe('integer');
    const snap = reply(restored, '10');
    expect(snap.value).toBe('askMonth');
    expect(snap.context.studentName).toBe('राम');
  });
});
