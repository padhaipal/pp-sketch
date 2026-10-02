import { censorTranscript, REDACTED_MARKER } from './transcript-censor';

describe('censorTranscript', () => {
  it('leaves an ordinary reading transcript untouched', () => {
    expect(censorTranscript('कमल घर जा रहा है')).toEqual({
      text: 'कमल घर जा रहा है',
      redactions: 0,
    });
    // short numbers (a page, a count) are not phone numbers
    expect(censorTranscript('page 12 and 345').redactions).toBe(0);
  });

  it('removes phone-number-like digit runs, with or without separators', () => {
    expect(censorTranscript('call me on 9876543210 ok')).toEqual({
      text: `call me on ${REDACTED_MARKER} ok`,
      redactions: 1,
    });
    expect(censorTranscript('98765 43210 and 98-76-54-32-10').redactions).toBe(
      2,
    );
    expect(censorTranscript('123456').text).toBe(REDACTED_MARKER);
  });

  it('removes the name after "my name is" in English, Hindi and romanised Hindi', () => {
    expect(censorTranscript('my name is Rani Devi and I read').text).toBe(
      `my name is ${REDACTED_MARKER} and I read`,
    );
    expect(censorTranscript('mera naam Bittu hai').text).toBe(
      `mera naam ${REDACTED_MARKER} hai`,
    );
    expect(censorTranscript('मेरा नाम राधा है').text).toBe(
      `मेरा नाम ${REDACTED_MARKER} है`,
    );
    expect(censorTranscript('I am Rani.').text).toBe(
      `I am ${REDACTED_MARKER}.`,
    );
  });

  it('removes the known names as whole words, longest first, any case', () => {
    const out = censorTranscript(
      'rani devi reads with Rani and Devi, not Ranil',
      ['Rani Devi'],
    );
    expect(out.text).toBe(
      `${REDACTED_MARKER} reads with ${REDACTED_MARKER} and ${REDACTED_MARKER}, not Ranil`,
    );
    expect(out.redactions).toBe(3);
    // Devanagari names: word boundaries by letter class
    expect(censorTranscript('राधा पढ़ती है', ['राधा']).text).toBe(
      `${REDACTED_MARKER} पढ़ती है`,
    );
  });

  it('ignores null / blank / short known names', () => {
    expect(
      censorTranscript('Al is here', [null, undefined, '', 'Al']).redactions,
    ).toBe(0);
  });

  it('counts every removal', () => {
    const out = censorTranscript('mera naam Rani hai, phone 9876543210, Rani', [
      'Rani',
    ]);
    expect(out.text).toBe(
      `mera naam ${REDACTED_MARKER} hai, phone ${REDACTED_MARKER}, ${REDACTED_MARKER}`,
    );
    expect(out.redactions).toBe(3);
  });
});
