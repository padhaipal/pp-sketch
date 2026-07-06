// End-to-end machine flows with the REAL marking utils (no mocks), pinning
// the production bug where standalone-matra letter drills (cCount === 0 in
// markLetter) rejected correct student answers like 'ै' answered as 'ए'.

import { createActor } from 'xstate';
import { machine } from './literacy-lesson.machine';

function makeActor(word: string) {
  const actor = createActor(machine, {
    input: { word, userMessageId: 'mm-integration' },
  });
  actor.start();
  return actor;
}

describe('literacy-lesson machine + real evaluate-answer utils', () => {
  it('drilling ै: student answering ए is accepted (reported bug)', () => {
    const actor = makeActor('मैना');

    // Word attempt misses the matras → drills wrongLetters ['ै', 'ा'].
    actor.send({ type: 'ANSWER', studentAnswer: 'मन' });
    let snap = actor.getSnapshot();
    expect(snap.value).toBe('letter');
    expect(snap.context.wrongLetters).toEqual(['ै', 'ा']);
    expect(snap.context.answer).toBe('ै');

    // ASR renders a bare "ai" as the independent vowel ए (same family).
    actor.send({ type: 'ANSWER', studentAnswer: 'ए' });
    snap = actor.getSnapshot();
    expect(snap.context.answerCorrect).toBe(true);
    expect(snap.context.pendingCorrect).toEqual(['ै']);
    expect(snap.value).toBe('letter'); // routeWrongLetter → next letter 'ा'
    expect(snap.context.answer).toBe('ा');

    // Second drilled letter 'ा' answered as अ (family vowel).
    actor.send({ type: 'ANSWER', studentAnswer: 'अ' });
    snap = actor.getSnapshot();
    expect(snap.context.answerCorrect).toBe(true);
    expect(snap.context.pendingCorrect).toEqual(['ा']);
    expect(snap.value).toBe('word');

    actor.stop();
  });

  it('drilling ै: ASR word है is accepted', () => {
    const actor = makeActor('मैना');
    actor.send({ type: 'ANSWER', studentAnswer: 'मन' });

    actor.send({ type: 'ANSWER', studentAnswer: 'है।' });
    const snap = actor.getSnapshot();
    expect(snap.context.answerCorrect).toBe(true);
    expect(snap.context.pendingCorrect).toEqual(['ै']);
    actor.stop();
  });

  it('drilling ो: student answering औ or ओह is accepted', () => {
    for (const studentAnswer of ['औ', 'ओह']) {
      const actor = makeActor('मोर');
      actor.send({ type: 'ANSWER', studentAnswer: 'मर' });
      let snap = actor.getSnapshot();
      expect(snap.context.answer).toBe('ो');

      actor.send({ type: 'ANSWER', studentAnswer });
      snap = actor.getSnapshot();
      expect(snap.context.answerCorrect).toBe(true);
      expect(snap.context.pendingCorrect).toEqual(['ो']);
      actor.stop();
    }
  });

  it('drilling ं (anusvara): student answering अं is accepted', () => {
    const actor = makeActor('रंग');
    actor.send({ type: 'ANSWER', studentAnswer: 'रग' });
    let snap = actor.getSnapshot();
    expect(snap.context.wrongLetters).toEqual(['ं']);
    expect(snap.context.answer).toBe('ं');

    actor.send({ type: 'ANSWER', studentAnswer: 'अं' });
    snap = actor.getSnapshot();
    expect(snap.context.answerCorrect).toBe(true);
    expect(snap.context.pendingCorrect).toEqual(['ं']);
    expect(snap.value).toBe('word');
    actor.stop();
  });

  it('drilling ै: a genuinely wrong answer (ओ) is still rejected', () => {
    const actor = makeActor('मैना');
    actor.send({ type: 'ANSWER', studentAnswer: 'मन' });

    actor.send({ type: 'ANSWER', studentAnswer: 'ओ' });
    const snap = actor.getSnapshot();
    expect(snap.context.answerCorrect).toBe(false);
    expect(snap.context.pendingIncorrect).toEqual(['ै']);
    expect(snap.value).toBe('image');
    actor.stop();
  });

  it('combined sarvam+azure transcript ("ए ऐ") passes the ै drill', () => {
    // literacy-lesson.service.ts joins engine transcripts with a space; any
    // one token passing markLetter is enough.
    const actor = makeActor('मैना');
    actor.send({ type: 'ANSWER', studentAnswer: 'मन' });

    actor.send({ type: 'ANSWER', studentAnswer: 'ए ऐ' });
    const snap = actor.getSnapshot();
    expect(snap.context.answerCorrect).toBe(true);
    actor.stop();
  });
});
