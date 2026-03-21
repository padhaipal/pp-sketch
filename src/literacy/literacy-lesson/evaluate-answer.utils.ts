/* ───────── constants ───────── */
const CONSONANT_SET = new Set(
  'अआइईउऊऋॠऌॡएऐओऔकखगघङचछजझञटठडढणतथदधनपफबभमयरलवशषसहabcdefghijklmnopqrstuvwxyz'.split(
    '',
  ),
);

const VOWEL_MATRA_SET = new Set(
  'ा ि ी ु ू ृ ॄ े ै ो ौ ॢ ॣ'.replace(/\s+/g, '').split(''),
);

const LONG_A = 'ा';

const FAMILIES: string[][] = [
  ['क', 'ख', 'क़', 'ख़'],
  ['ग', 'घ', 'ग़'],
  ['च', 'छ'],
  ['ज', 'झ', 'ज़'],
  ['ट', 'ठ', 'त', 'थ'],
  ['ड', 'ढ', 'द', 'ध'],
  ['प', 'फ', 'फ़'],
  ['ब', 'भ'],
  ['श', 'ष', 'स'],
  ['र', 'ड़', 'ढ़'],
  ['य', 'ए', 'ऐ'],
  ['ओ', 'औ'],
  ['अ', 'आ'],
  ['इ', 'ई'],
  ['उ', 'ऊ'],
  ['ऋ', 'ॠ'],
  ['ऌ', 'ॡ'],
  ['ड', 'ड़'],
  ['ङ'],
  ['ञ'],
  ['ण'],
  ['न'],
  ['म'],
  ['ल'],
  ['व'],
  ['ह'],
];

const sameFamily = (a: string, b: string) =>
  FAMILIES.some((fam) => fam.includes(a) && fam.includes(b));

const MATRAS = new Set([
  'ा', 'ि', 'ी', 'ु', 'ू', 'ृ', 'े', 'ै', 'ो', 'ौ',
]);

type MarkArgs = { correctAnswer: string; studentAnswer: string };

/* ───────── utility class ───────── */
class EvaluateAnswer {
  /* helpers */
  private static isConsonant = (ch: string) => CONSONANT_SET.has(ch);

  private static consonantCount(word: string): number {
    let c = 0;
    for (const ch of [...word.normalize('NFC')]) {
      if (this.isConsonant(ch)) c++;
    }
    return c;
  }

  private static clean(str: string): string {
    return str
      .normalize('NFC')
      .trim()
      .replace(/[^\p{L}\p{M}\p{N}]/gu, '')
      .toLocaleLowerCase();
  }

  /* public APIs --------------------------------------------------- */

  static markWord({ correctAnswer, studentAnswer }: MarkArgs): boolean {
    const cleanedCorrectAnswer = this.clean(correctAnswer);
    const studentWords = studentAnswer.split(/\s+/);

    const isEquivalent = (a: string, b: string) => a === b || sameFamily(a, b);

    return studentWords.some((studentWord) => {
      const cleanedStudentWord = this.clean(studentWord);
      if (cleanedStudentWord === cleanedCorrectAnswer) return true;

      // Hard coding some common transcription engine mistakes.
      if (cleanedCorrectAnswer === 'ईख' && cleanedStudentWord === 'एक') return true;
      if (cleanedCorrectAnswer === 'दरवाज़ा' && cleanedStudentWord === 'दरवाजा') return true;
      if (cleanedCorrectAnswer === 'हथौड़ा' && cleanedStudentWord === 'हथौड़ी') return true;
      if (cleanedCorrectAnswer === 'हथौड़ी' && cleanedStudentWord === 'हथौड़ा') return true;
      if (cleanedCorrectAnswer === 'और' && cleanedStudentWord === 'ओर') return true;
      if (cleanedCorrectAnswer === 'ओर' && cleanedStudentWord === 'और') return true;
      if (cleanedCorrectAnswer === 'पढ़' && cleanedStudentWord === 'पड़') return true;
      if (cleanedCorrectAnswer === 'पड़' && cleanedStudentWord === 'पढ़') return true;
      if (cleanedCorrectAnswer === 'गए' && cleanedStudentWord === 'गये') return true;
      if (cleanedCorrectAnswer === 'गये' && cleanedStudentWord === 'गए') return true;
      if (cleanedCorrectAnswer === 'डर' && cleanedStudentWord === 'दर') return true;
      if (cleanedCorrectAnswer === 'दर' && cleanedStudentWord === 'डर') return true;
      if (cleanedCorrectAnswer === 'एक' && cleanedStudentWord === '1') return true;
      if (cleanedCorrectAnswer === 'एक' && cleanedStudentWord === 'एकाएक') return true;
      if (cleanedCorrectAnswer === 'दो' && cleanedStudentWord === '2') return true;
      if (cleanedCorrectAnswer === 'तीन' && cleanedStudentWord === '3') return true;
      if (cleanedCorrectAnswer === 'चार' && cleanedStudentWord === '4') return true;
      if (cleanedCorrectAnswer === 'पाँच' && cleanedStudentWord === '5') return true;
      if (cleanedCorrectAnswer === 'छह' && cleanedStudentWord === '6') return true;
      if (cleanedCorrectAnswer === 'सात' && cleanedStudentWord === '7') return true;
      if (cleanedCorrectAnswer === 'आठ' && cleanedStudentWord === '8') return true;
      if (cleanedCorrectAnswer === 'नौ' && cleanedStudentWord === '9') return true;
      if (cleanedCorrectAnswer === 'दस' && cleanedStudentWord === '10') return true;
      if (cleanedCorrectAnswer === 'बीस' && cleanedStudentWord === '20') return true;
      if (cleanedCorrectAnswer === 'तीस' && cleanedStudentWord === '30') return true;
      if (cleanedCorrectAnswer === 'चालीस' && cleanedStudentWord === '40') return true;
      if (cleanedCorrectAnswer === 'पचास' && cleanedStudentWord === '50') return true;
      if (cleanedCorrectAnswer === 'साठ' && cleanedStudentWord === '60') return true;
      if (cleanedCorrectAnswer === 'सत्तर' && cleanedStudentWord === '70') return true;
      if (cleanedCorrectAnswer === 'अस्सी' && cleanedStudentWord === '80') return true;
      if (cleanedCorrectAnswer === 'नब्बे' && cleanedStudentWord === '90') return true;
      if (cleanedCorrectAnswer === 'सौ' && cleanedStudentWord === '100') return true;
      if (cleanedCorrectAnswer === 'चख' && cleanedStudentWord === 'चकाचक') return true;
      if (cleanedCorrectAnswer === 'ठप' && cleanedStudentWord === 'थपाथप') return true;
      if (cleanedCorrectAnswer === 'तन' && cleanedStudentWord === 'टनाटन') return true;
      if (cleanedCorrectAnswer === 'फट' && cleanedStudentWord === 'फटाफट') return true;
      if (cleanedCorrectAnswer === 'भर' && cleanedStudentWord === 'बराबर') return true;
      if (cleanedCorrectAnswer === 'हट' && cleanedStudentWord === 'हताहत') return true;
      if (cleanedCorrectAnswer === 'गुण' && cleanedStudentWord === 'गुन') return true;
      if (cleanedCorrectAnswer === 'गुण' && cleanedStudentWord === 'गुड़') return true;
      if (cleanedCorrectAnswer === 'गुण' && cleanedStudentWord === 'गुर') return true;
      if (cleanedCorrectAnswer === 'गुण' && cleanedStudentWord === 'गुड') return true;
      if (cleanedCorrectAnswer === 'नहीं' && cleanedStudentWord === 'नई') return true;
      if (cleanedCorrectAnswer === 'नई' && cleanedStudentWord === 'नहीं') return true;
      if (cleanedCorrectAnswer === 'बच' && cleanedStudentWord === 'बच्च') return true;
      if (cleanedCorrectAnswer === 'हाँ' && cleanedStudentWord === 'हां') return true;
      if (cleanedCorrectAnswer === 'भय' && cleanedStudentWord === 'भाई') return true;
      if (cleanedCorrectAnswer === 'ऊन' && cleanedStudentWord === 'उन') return true;
      if (cleanedCorrectAnswer === 'उन' && cleanedStudentWord === 'ऊन') return true;
      if (cleanedCorrectAnswer === 'वह' && cleanedStudentWord === 'वे') return true;
      if (cleanedCorrectAnswer === 'वे' && cleanedStudentWord === 'वह') return true;
      if (cleanedCorrectAnswer === 'इडली' && cleanedStudentWord === 'इटली') return true;

      // Schwa deletion: ignore trailing long ā (ा) in correctAnswer
      if (
        cleanedCorrectAnswer.endsWith(LONG_A) &&
        cleanedStudentWord === cleanedCorrectAnswer.slice(0, -1)
      ) {
        return true;
      }

      // Match words that have characters in the same family in the same position.
      // Also allow for the student to prepend some characters to the student answer.
      if (cleanedCorrectAnswer.length === 0) {
        console.error(
          'markWord: cleanedCorrectAnswer is empty. Raw value was:',
          correctAnswer,
        );
        return false;
      }

      if (cleanedStudentWord.length >= cleanedCorrectAnswer.length) {
        const offset = cleanedStudentWord.length - cleanedCorrectAnswer.length;
        for (let i = 0; i < cleanedCorrectAnswer.length; i++) {
          if (!isEquivalent(cleanedStudentWord[i + offset], cleanedCorrectAnswer[i])) {
            return false;
          }
        }
        return true;
      }

      return false;
    });
  }

  /* markImage helpers */
  private static splitWord(word: string): string[] {
    return Array.from(word);
  }

  private static isMatra(char: string): boolean {
    return MATRAS.has(char);
  }

  static markImage({ correctAnswer, studentAnswer }: MarkArgs): boolean {
    const cleanedExampleWord = this.clean(correctAnswer);
    const cleanedExampleChars = this.splitWord(cleanedExampleWord);

    const splitStudentAnswer = studentAnswer.split(/\s+/);
    for (const studentWord of splitStudentAnswer) {
      const cleanedStudentWord = this.clean(studentWord);
      const cleanedStudentChars = this.splitWord(cleanedStudentWord);

      if (cleanedExampleChars.length === 0 || cleanedStudentChars.length === 0) {
        continue;
      }
      if (cleanedExampleChars[0] !== cleanedStudentChars[0] && !sameFamily(cleanedExampleChars[0], cleanedStudentChars[0])) continue;
      // Todo: I need to hard code checks for matra images here since those words don't start with the matra character.
      return true;
    }
    return false;
  }

  static markLetter({ correctAnswer, studentAnswer }: MarkArgs): boolean {
    const cleanedCorrectAnswer = this.clean(correctAnswer);
    const words = studentAnswer.trim().split(/\s+/);
    const cCount = this.consonantCount(cleanedCorrectAnswer);

    return words.some((w) => {
      const cleaned = this.clean(w);

      // Hard coding some common transcription engine mistakes.
      if (cleanedCorrectAnswer === 'म' && cleaned === 'माँ') return true;
      if (cleanedCorrectAnswer === 'ह' && cleaned === 'हां') return true;
      if (cleanedCorrectAnswer === 'औ' && cleaned === 'ओह') return true;
      if (cleanedCorrectAnswer === 'ओ' && cleaned === 'ओह') return true;
      if (cleanedCorrectAnswer === 'आ' && cleaned === 'हाँ') return true;
      if (cleanedCorrectAnswer === 'आ' && cleaned === 'हां') return true;
      if (cleanedCorrectAnswer === 'आ' && cleaned === 'का') return true;
      if (cleanedCorrectAnswer === 'ा' && cleaned === 'आ') return true;
      if (cleanedCorrectAnswer === 'ा' && cleaned === 'हाँ') return true;
      if (cleanedCorrectAnswer === 'ा' && cleaned === 'हां') return true;
      if (cleanedCorrectAnswer === 'ा' && cleaned === 'का') return true;
      if (cleanedCorrectAnswer === 'ि' && cleaned === 'इ') return true;
      if (cleanedCorrectAnswer === 'ी' && cleaned === 'ई') return true;
      if (cleanedCorrectAnswer === 'ु' && cleaned === 'उ') return true;
      if (cleanedCorrectAnswer === 'ू' && cleaned === 'ऊ') return true;
      if (cleanedCorrectAnswer === 'ृ' && cleaned === 'ऋ') return true;
      if (cleanedCorrectAnswer === 'े' && cleaned === 'ए') return true;
      if (cleanedCorrectAnswer === 'ै' && cleaned === 'ऐ') return true;
      if (cleanedCorrectAnswer === 'ो' && cleaned === 'ओ') return true;
      if (cleanedCorrectAnswer === 'ौ' && cleaned === 'औ') return true;
      if (cleanedCorrectAnswer === 'ओ' && cleaned === 'आओ') return true;
      if (cleanedCorrectAnswer === 'ऋ' && cleaned === 'री') return true;
      if (cleanedCorrectAnswer === 'ऋ' && cleaned === 'रि') return true;
      if (cleanedCorrectAnswer === 'श' && cleaned === 'शाह') return true;
      if (cleanedCorrectAnswer === 'ष' && cleaned === 'शाह') return true;
      if (cleanedCorrectAnswer === 'ा' && cleaned === 'बड़ा') return true;
      if (cleanedCorrectAnswer === 'ी' && cleaned === 'बड़ी') return true;
      if (cleanedCorrectAnswer === 'ए' && cleaned === 'ऐसे') return true;
      if (cleanedCorrectAnswer === 'ब' && cleaned === 'वाह') return true;
      if (cleanedCorrectAnswer === 'ख' && cleaned === 'हाँ') return true;
      if (cleanedCorrectAnswer === 'ऐ' && cleaned === 'है') return true;
      if (cleanedCorrectAnswer === 'ऐ' && cleaned === 'हाय') return true;
      if (cleanedCorrectAnswer === 'छ' && cleaned === 'अच्छा') return true;
      if (cleanedCorrectAnswer === 'ि' && cleaned === 'ई') return true;
      if (cleanedCorrectAnswer === 'ी' && cleaned === 'इ') return true;
      if (cleanedCorrectAnswer === 'ु' && cleaned === 'ऊ') return true;
      if (cleanedCorrectAnswer === 'ू' && cleaned === 'उ') return true;

      if (cCount === 1) {
        return this.markPhoneme(cleanedCorrectAnswer, cleaned);
      } else if (cCount === 2) {
        return this.markConjunct(cleanedCorrectAnswer, cleaned);
      } else {
        return false;
      }
    });
  }

  private static markPhoneme(correctAnswer: string, word: string): boolean {
    if (!word || !correctAnswer) return false;
    if (word === correctAnswer) return true;

    const baseMatches =
      word[0] === correctAnswer[0] || sameFamily(word[0], correctAnswer[0]);

    if (baseMatches) {
      if (word.slice(1) === correctAnswer.slice(1)) return true;
      if (word.slice(1) === LONG_A && correctAnswer.slice(1) === '') return true;
    }
    return false;
  }

  private static markConjunct(correctAnswer: string, word: string): boolean {
    return word === correctAnswer;
  }

  static detectIncorrectEndMatra({ correctAnswer, studentAnswer }: MarkArgs): boolean {
    const cleanedCorrect = this.clean(correctAnswer);
    return studentAnswer
      .trim()
      .split(/\s+/)
      .some((w) => this.clean(w) === cleanedCorrect + LONG_A);
  }

  static detectInsertion({ correctAnswer, studentAnswer }: MarkArgs): boolean {
    const cleanedCorrect = this.clean(correctAnswer);
    if (cleanedCorrect.length === 0) {
      console.error(
        'detectInsertion: cleanedCorrect is empty. Raw value was:',
        correctAnswer,
      );
      return false;
    }
    return studentAnswer.split(/\s+/).some((studentWord) => {
      const cleanedStudent = this.clean(studentWord);
      if (cleanedStudent.length <= cleanedCorrect.length) return false;
      const correctChars = Array.from(cleanedCorrect);
      const studentChars = Array.from(cleanedStudent);
      let ci = 0;
      for (const ch of studentChars) {
        if (ch === correctChars[ci]) ci++;
        if (ci === correctChars.length) return true;
      }
      return false;
    });
  }

  static detectIncorrectMiddleMatra({ correctAnswer, studentAnswer }: MarkArgs): boolean {
    const cleanT = correctAnswer.normalize('NFC');
    const cleanS = studentAnswer.normalize('NFC');

    if (this.consonantCount(cleanT) !== 4) return false;
    if (cleanT.includes('\u094D')) return false;
    if (this.consonantCount(cleanS) !== 4) return false;
    if (cleanS.includes('\u094D')) return false;

    const hasMatraBetween = (word: string) => {
      const chars = [...word];
      const idx = chars
        .map((ch, i) => (this.isConsonant(ch) ? i : -1))
        .filter((i) => i !== -1);

      const between = chars.slice(idx[1] + 1, idx[2]);
      return between.some((ch) => VOWEL_MATRA_SET.has(ch));
    };

    return !hasMatraBetween(cleanT) && hasMatraBetween(cleanS);
  }
}

export type { MarkArgs };
export const markWord = (args: MarkArgs) => EvaluateAnswer.markWord(args);
export const markImage = (args: MarkArgs) => EvaluateAnswer.markImage(args);
export const markLetter = (args: MarkArgs) => EvaluateAnswer.markLetter(args);
export const detectInsertion = (args: MarkArgs) =>
  EvaluateAnswer.detectInsertion(args);
export const detectIncorrectEndMatra = (args: MarkArgs) =>
  EvaluateAnswer.detectIncorrectEndMatra(args);
export const detectIncorrectMiddleMatra = (args: MarkArgs) =>
  EvaluateAnswer.detectIncorrectMiddleMatra(args);
