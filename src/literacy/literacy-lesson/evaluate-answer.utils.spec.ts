import {
  markWord,
  markImage,
  markLetter,
  detectInsertion,
  detectIncorrectEndMatra,
  detectIncorrectMiddleMatra,
} from './evaluate-answer.utils';

describe('evaluate-answer.utils', () => {
  /* ───────── markWord ───────── */
  describe('markWord', () => {
    /* -- the case the user explicitly asked about -- */
    it('returns false for correct=सोयाबीन student=हाँ जी', () => {
      // Both student tokens are shorter than correct (3 and 2 vs 7 UTF-16 units)
      // so the suffix-matching path is skipped and no hardcode applies.
      expect(
        markWord({ correctAnswer: 'सोयाबीन', studentAnswer: 'हाँ जी' }),
      ).toBe(false);
    });

    /* -- exact match -- */
    it('returns true for an exact single-word match', () => {
      expect(markWord({ correctAnswer: 'राम', studentAnswer: 'राम' })).toBe(
        true,
      );
    });

    it('returns true when the correct word appears among student words', () => {
      expect(
        markWord({ correctAnswer: 'राम', studentAnswer: 'मेरा राम है' }),
      ).toBe(true);
    });

    it('is case-insensitive for English answers', () => {
      expect(markWord({ correctAnswer: 'Hello', studentAnswer: 'HELLO' })).toBe(
        true,
      );
    });

    it('strips punctuation before comparing', () => {
      expect(markWord({ correctAnswer: 'राम!', studentAnswer: 'राम.' })).toBe(
        true,
      );
    });

    it('normalizes NFC so decomposed equals composed', () => {
      // क + nukta (decomposed) vs क़ (precomposed)
      const decomposed = 'क़';
      const precomposed = 'क़';
      expect(
        markWord({ correctAnswer: precomposed, studentAnswer: decomposed }),
      ).toBe(true);
    });

    /* -- hardcoded transcription corrections (sample, not exhaustive) -- */
    it.each([
      ['ईख', 'एक'],
      ['दरवाज़ा', 'दरवाजा'],
      ['हथौड़ा', 'हथौड़ी'],
      ['हथौड़ी', 'हथौड़ा'],
      ['और', 'ओर'],
      ['ओर', 'और'],
      ['पढ़', 'पड़'],
      ['गए', 'गये'],
      ['डर', 'दर'],
      ['नहीं', 'नई'],
      ['हाँ', 'हां'],
      ['वह', 'वे'],
      ['इडली', 'इटली'],
      ['एक', 'एकाएक'],
    ])(
      'accepts hardcoded transcription pair correct=%s student=%s',
      (correct, student) => {
        expect(
          markWord({ correctAnswer: correct, studentAnswer: student }),
        ).toBe(true);
      },
    );

    it.each([
      ['एक', '1'],
      ['दो', '2'],
      ['तीन', '3'],
      ['दस', '10'],
      ['बीस', '20'],
      ['सौ', '100'],
    ])('accepts numeral for Hindi number word correct=%s', (correct, num) => {
      expect(markWord({ correctAnswer: correct, studentAnswer: num })).toBe(
        true,
      );
    });

    it('does NOT accept the reverse direction of asymmetric hardcodes', () => {
      // 'ईख' → 'एक' is hardcoded, but the inverse is not.
      expect(markWord({ correctAnswer: 'एक', studentAnswer: 'ईख' })).toBe(
        false,
      );
    });

    /* -- schwa-deletion / trailing-ā truncation -- */
    it('accepts the correct word with the trailing ा removed', () => {
      expect(markWord({ correctAnswer: 'कमरा', studentAnswer: 'कमर' })).toBe(
        true,
      );
    });

    it('does not accept arbitrary truncation when correct does not end in ा', () => {
      expect(markWord({ correctAnswer: 'राम', studentAnswer: 'रा' })).toBe(
        false,
      );
    });

    /* -- suffix / prepended-prefix matching -- */
    it('matches when student prepends extra characters before the correct word', () => {
      // 'अबस' length 3, 'बस' length 2 → offset 1, suffix matches.
      expect(markWord({ correctAnswer: 'बस', studentAnswer: 'अबस' })).toBe(
        true,
      );
    });

    it('returns false when student is shorter than correct', () => {
      expect(markWord({ correctAnswer: 'सोयाबीन', studentAnswer: 'सो' })).toBe(
        false,
      );
    });

    it('returns false when one mismatched (non-family) char in suffix', () => {
      expect(markWord({ correctAnswer: 'राम', studentAnswer: 'रास' })).toBe(
        false,
      );
    });

    /* -- family equivalence -- */
    it('treats family members as equivalent at corresponding positions', () => {
      // ट and त same family; ठ and थ same family.
      expect(markWord({ correctAnswer: 'टठ', studentAnswer: 'तथ' })).toBe(true);
    });

    it('does NOT actually treat nukta variant ज़ and ज as same family (FAMILIES bug)', () => {
      // NFC does not compose ज+़ into U+095B (it's in Unicode's composition
      // exclusion list), and markWord compares one UTF-16 code unit at a time.
      // So although FAMILIES contains the multi-char string 'ज़', sameFamily
      // never sees it during the per-position compare. Documenting the gap.
      expect(markWord({ correctAnswer: 'जा', studentAnswer: 'ज़ा' })).toBe(
        false,
      );
    });

    /* -- empty / whitespace inputs -- */
    it('returns false for empty correctAnswer (and logs an error)', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      expect(markWord({ correctAnswer: '', studentAnswer: 'राम' })).toBe(false);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('returns false for empty studentAnswer', () => {
      expect(markWord({ correctAnswer: 'राम', studentAnswer: '' })).toBe(false);
    });

    it('returns false for whitespace-only studentAnswer', () => {
      expect(markWord({ correctAnswer: 'राम', studentAnswer: '   ' })).toBe(
        false,
      );
    });

    /* -- combined transcripts from multiple STT services -- */
    describe('combined transcripts from multiple STT services', () => {
      // literacy-lesson.service.ts joins all STT transcripts with a space,
      // so the full answer contains duplicated text. Hardcoded multi-syllable
      // checks must use .includes() rather than ===.
      it('accepts नाशपाती when sarvam+azure both emit "नाश पाती"', () => {
        const combined = ['नाश पाती', 'नाश पाती।'].join(' ');
        expect(
          markWord({ correctAnswer: 'नाशपाती', studentAnswer: combined }),
        ).toBe(true);
      });

      it('accepts दालचीनी when sarvam+azure both emit "दाल चीनी"', () => {
        const combined = ['दाल चीनी', 'दाल चीनी।'].join(' ');
        expect(
          markWord({ correctAnswer: 'दालचीनी', studentAnswer: combined }),
        ).toBe(true);
      });

      it('accepts तकिया when combined transcript is "तक या तक या"', () => {
        const combined = ['तक या', 'तक या'].join(' ');
        expect(
          markWord({ correctAnswer: 'तकिया', studentAnswer: combined }),
        ).toBe(true);
      });

      it('accepts पुलिस when combined transcript is "पुल इस पुल इस"', () => {
        const combined = ['पुल इस', 'पुल इस'].join(' ');
        expect(
          markWord({ correctAnswer: 'पुलिस', studentAnswer: combined }),
        ).toBe(true);
      });

      it('accepts अमरस when combined transcript is "अमर रस अमर रस"', () => {
        const combined = ['अमर रस', 'अमर रस'].join(' ');
        expect(
          markWord({ correctAnswer: 'अमरस', studentAnswer: combined }),
        ).toBe(true);
      });
    });

    /* -- ण / न / र / ल families: ण equates to न, and ल equates to र,
       but the groups do not transitively equate (FAMILIES has ['ण','न']
       and ['ल','र'] as separate rows). -- */
    it('treats ण and न as the same family', () => {
      expect(markWord({ correctAnswer: 'णन', studentAnswer: 'नण' })).toBe(true);
    });

    /* -- nasal-sign family: ं ~ ँ ~ ः are interchangeable per position -- */
    it('treats anusvara ं and chandrabindu ँ as the same family', () => {
      expect(markWord({ correctAnswer: 'रंग', studentAnswer: 'रँग' })).toBe(
        true,
      );
    });

    it('treats anusvara ं and visarga ः as the same family', () => {
      expect(markWord({ correctAnswer: 'रंग', studentAnswer: 'रःग' })).toBe(
        true,
      );
    });

    it('does NOT treat ण and र as the same family', () => {
      expect(markWord({ correctAnswer: 'णर', studentAnswer: 'रण' })).toBe(
        false,
      );
    });

    it('does NOT treat न and र as the same family', () => {
      expect(markWord({ correctAnswer: 'नर', studentAnswer: 'रन' })).toBe(
        false,
      );
    });

    it('treats ल and र as the same family', () => {
      expect(markWord({ correctAnswer: 'लर', studentAnswer: 'रल' })).toBe(true);
    });
  });

  /* ───────── markImage ───────── */
  describe('markImage', () => {
    it('returns true when first char of any student word matches first char of correct', () => {
      expect(markImage({ correctAnswer: 'सेब', studentAnswer: 'सेब' })).toBe(
        true,
      );
    });

    it('returns true when first chars are in the same family', () => {
      // ट and त same family.
      expect(
        markImage({ correctAnswer: 'टमाटर', studentAnswer: 'तमाटर' }),
      ).toBe(true);
    });

    it('returns false when first char differs and is not in same family', () => {
      expect(markImage({ correctAnswer: 'सेब', studentAnswer: 'राम' })).toBe(
        false,
      );
    });

    it('returns true when the matching word is anywhere in student answer', () => {
      expect(
        markImage({ correctAnswer: 'सेब', studentAnswer: 'मुझे सेब चाहिए' }),
      ).toBe(true);
    });

    it('returns false for empty studentAnswer', () => {
      expect(markImage({ correctAnswer: 'सेब', studentAnswer: '' })).toBe(
        false,
      );
    });

    it('returns false for empty correctAnswer', () => {
      expect(markImage({ correctAnswer: '', studentAnswer: 'सेब' })).toBe(
        false,
      );
    });

    /* matra grapheme as correctAnswer — student answers the parent-vowel word */
    it('matches ा against आम (parent vowel आ)', () => {
      expect(markImage({ correctAnswer: 'ा', studentAnswer: 'आम' })).toBe(true);
    });

    it('matches ि against इमली (parent vowel इ)', () => {
      expect(markImage({ correctAnswer: 'ि', studentAnswer: 'इमली' })).toBe(
        true,
      );
    });

    it('matches ी against ईंट (parent vowel ई)', () => {
      expect(markImage({ correctAnswer: 'ी', studentAnswer: 'ईंट' })).toBe(
        true,
      );
    });

    it('matches ु against उल्लू (parent vowel उ)', () => {
      expect(markImage({ correctAnswer: 'ु', studentAnswer: 'उल्लू' })).toBe(
        true,
      );
    });

    it('matches ू against ऊन (parent vowel ऊ)', () => {
      expect(markImage({ correctAnswer: 'ू', studentAnswer: 'ऊन' })).toBe(true);
    });

    it('matches ृ against ऋषि (parent vowel ऋ)', () => {
      expect(markImage({ correctAnswer: 'ृ', studentAnswer: 'ऋषि' })).toBe(
        true,
      );
    });

    it('matches े against एक (parent vowel ए)', () => {
      expect(markImage({ correctAnswer: 'े', studentAnswer: 'एक' })).toBe(true);
    });

    it('matches ै against ऐनक (parent vowel ऐ)', () => {
      expect(markImage({ correctAnswer: 'ै', studentAnswer: 'ऐनक' })).toBe(
        true,
      );
    });

    it('matches ो against ओखली (parent vowel ओ)', () => {
      expect(markImage({ correctAnswer: 'ो', studentAnswer: 'ओखली' })).toBe(
        true,
      );
    });

    it('matches ौ against औरत (parent vowel औ)', () => {
      expect(markImage({ correctAnswer: 'ौ', studentAnswer: 'औरत' })).toBe(
        true,
      );
    });

    it('matches ं against अंगूर (parent vowel अ)', () => {
      expect(markImage({ correctAnswer: 'ं', studentAnswer: 'अंगूर' })).toBe(
        true,
      );
    });

    it('matches matra against different word starting with parent vowel (ा vs आलू)', () => {
      expect(markImage({ correctAnswer: 'ा', studentAnswer: 'आलू' })).toBe(
        true,
      );
    });

    it('returns false for matra when student word starts with unrelated char', () => {
      expect(markImage({ correctAnswer: 'ा', studentAnswer: 'राम' })).toBe(
        false,
      );
    });
  });

  /* ───────── markLetter ───────── */
  describe('markLetter', () => {
    /* -- hardcoded mappings (sample) -- */
    it.each([
      ['म', 'माँ'],
      ['ह', 'हां'],
      ['औ', 'ओह'],
      ['आ', 'का'],
      ['ा', 'आ'],
      ['ि', 'इ'],
      ['ी', 'ई'],
      ['ु', 'उ'],
      ['ो', 'ओ'],
      ['ृ', 'ऋ'],
      ['ऋ', 'री'],
      ['छ', 'अच्छा'],
    ])('accepts hardcoded letter pair correct=%s student=%s', (c, s) => {
      expect(markLetter({ correctAnswer: c, studentAnswer: s })).toBe(true);
    });

    /* -- single-consonant phoneme path -- */
    it('matches a bare consonant against itself', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'क' })).toBe(true);
    });

    it('matches a bare consonant against same-family consonant', () => {
      // क and ख same family.
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'ख' })).toBe(true);
    });

    it('matches a bare consonant against consonant + ा (schwa)', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'का' })).toBe(
        true,
      );
    });

    it('matches consonant + matra against same consonant + matra', () => {
      expect(markLetter({ correctAnswer: 'के', studentAnswer: 'के' })).toBe(
        true,
      );
    });

    it('matches consonant + matra against same-family consonant + same matra', () => {
      expect(markLetter({ correctAnswer: 'के', studentAnswer: 'खे' })).toBe(
        true,
      );
    });

    it('rejects bare consonant when student adds a non-ā matra', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'के' })).toBe(
        false,
      );
    });

    it('rejects different (non-family) consonants', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'प' })).toBe(
        false,
      );
    });

    /* -- two-consonant conjunct path is strict -- */
    it('matches a conjunct only by exact equality', () => {
      expect(markLetter({ correctAnswer: 'क्ष', studentAnswer: 'क्ष' })).toBe(
        true,
      );
      expect(markLetter({ correctAnswer: 'क्ष', studentAnswer: 'क्श' })).toBe(
        false,
      );
    });

    it('returns false for >2-consonant correct that is not hardcoded', () => {
      expect(
        markLetter({ correctAnswer: 'त्र्य', studentAnswer: 'त्र्य' }),
      ).toBe(false);
    });

    /* -- multi-word student input -- */
    it('passes when any whitespace-split student token matches', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'अ इ क' })).toBe(
        true,
      );
    });

    /* -- bare matra (cCount === 0): family vowels and vowel-hardcode mirrors -- */
    it.each([
      // family-equivalent vowel
      ['ा', 'अ'],
      ['े', 'ऐ'],
      ['ै', 'ए'],
      ['ो', 'औ'],
      ['ौ', 'ओ'],
      // mirrors of the independent vowel's hardcodes
      ['ो', 'ओह'],
      ['ो', 'आओ'],
      ['ौ', 'ओह'],
      ['ै', 'है'],
      ['ै', 'हाय'],
      ['े', 'ऐसे'],
      // family-transitive mirrors (े ~ ऐ family)
      ['े', 'है'],
      ['े', 'हाय'],
      ['े', 'आए'],
      ['ै', 'ऐसे'],
      // anusvara
      ['ं', 'अं'],
      ['ं', 'आं'],
      ['ं', 'हं'],
    ])('accepts bare-matra pair correct=%s student=%s', (c, s) => {
      expect(markLetter({ correctAnswer: c, studentAnswer: s })).toBe(true);
    });

    it('accepts a bare matra echoed exactly (e.g. ृ vs ृ)', () => {
      expect(markLetter({ correctAnswer: 'ृ', studentAnswer: 'ृ' })).toBe(true);
    });

    it.each([
      ['ि', 'ए'], // cross-family vowel stays rejected
      ['ो', 'आ'],
      ['ै', 'ओ'],
      ['ं', 'अ'], // bare अ is not accepted for anusvara
      ['ी', 'ि'], // bare-matra echo is exact-only, not family-wide
    ])('still rejects bare-matra pair correct=%s student=%s', (c, s) => {
      expect(markLetter({ correctAnswer: c, studentAnswer: s })).toBe(false);
    });
  });

  /* ───────── detectInsertion ───────── */
  describe('detectInsertion', () => {
    it('returns true when student inserts extra chars between correct chars', () => {
      expect(
        detectInsertion({ correctAnswer: 'कलम', studentAnswer: 'कXलYम' }),
      ).toBe(true);
    });

    it('returns true when student is correct + extra trailing chars', () => {
      expect(
        detectInsertion({ correctAnswer: 'राम', studentAnswer: 'रामायण' }),
      ).toBe(true);
    });

    it('returns false when student is exactly the correct word', () => {
      expect(
        detectInsertion({ correctAnswer: 'राम', studentAnswer: 'राम' }),
      ).toBe(false);
    });

    it('returns false when student is shorter than correct', () => {
      expect(
        detectInsertion({ correctAnswer: 'राम', studentAnswer: 'रा' }),
      ).toBe(false);
    });

    it('returns false when correct chars are not a subsequence of student', () => {
      expect(
        detectInsertion({ correctAnswer: 'कलम', studentAnswer: 'मलक' }),
      ).toBe(false);
    });

    it('returns false (and logs) for empty correctAnswer', () => {
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      expect(detectInsertion({ correctAnswer: '', studentAnswer: 'राम' })).toBe(
        false,
      );
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('returns false for empty studentAnswer', () => {
      expect(detectInsertion({ correctAnswer: 'राम', studentAnswer: '' })).toBe(
        false,
      );
    });

    it('checks each space-split student word independently', () => {
      expect(
        detectInsertion({ correctAnswer: 'राम', studentAnswer: 'XX रामायण' }),
      ).toBe(true);
    });
  });

  /* ───────── detectIncorrectEndMatra ───────── */
  describe('detectIncorrectEndMatra', () => {
    it('returns true when student appends a stray ा to the correct word', () => {
      expect(
        detectIncorrectEndMatra({
          correctAnswer: 'राम',
          studentAnswer: 'रामा',
        }),
      ).toBe(true);
    });

    it('returns false when student equals correct exactly', () => {
      expect(
        detectIncorrectEndMatra({ correctAnswer: 'राम', studentAnswer: 'राम' }),
      ).toBe(false);
    });

    it('returns false when student appends something other than ा', () => {
      expect(
        detectIncorrectEndMatra({
          correctAnswer: 'राम',
          studentAnswer: 'रामी',
        }),
      ).toBe(false);
    });

    it('detects the stray-ā token among multiple words', () => {
      expect(
        detectIncorrectEndMatra({
          correctAnswer: 'राम',
          studentAnswer: 'मेरा रामा है',
        }),
      ).toBe(true);
    });

    it('returns false for empty studentAnswer', () => {
      expect(
        detectIncorrectEndMatra({ correctAnswer: 'राम', studentAnswer: '' }),
      ).toBe(false);
    });
  });

  /* ───────── detectIncorrectMiddleMatra ───────── */
  describe('detectIncorrectMiddleMatra', () => {
    it('returns true when correct has no middle matra and student has one', () => {
      // Both have 4 consonants; student has a matra between 2nd and 3rd.
      // Correct: क ब र द (4 consonants, no middle matra)
      // Student: क ब ा र द → matra ा between 2nd (ब) and 3rd (र) consonant
      expect(
        detectIncorrectMiddleMatra({
          correctAnswer: 'कबरद',
          studentAnswer: 'कबारद',
        }),
      ).toBe(true);
    });

    it('returns false when both have a middle matra', () => {
      expect(
        detectIncorrectMiddleMatra({
          correctAnswer: 'कबारद',
          studentAnswer: 'कबारद',
        }),
      ).toBe(false);
    });

    it('returns false when neither has a middle matra', () => {
      expect(
        detectIncorrectMiddleMatra({
          correctAnswer: 'कबरद',
          studentAnswer: 'कबरद',
        }),
      ).toBe(false);
    });

    it('returns false when consonant count is not exactly 4', () => {
      expect(
        detectIncorrectMiddleMatra({
          correctAnswer: 'कबर',
          studentAnswer: 'कबार',
        }),
      ).toBe(false);
    });

    it('returns false when correctAnswer contains a halant (्)', () => {
      expect(
        detectIncorrectMiddleMatra({
          correctAnswer: 'क्बरद',
          studentAnswer: 'कबारद',
        }),
      ).toBe(false);
    });

    it('returns false when studentAnswer contains a halant (्)', () => {
      expect(
        detectIncorrectMiddleMatra({
          correctAnswer: 'कबरद',
          studentAnswer: 'क्बारद',
        }),
      ).toBe(false);
    });
  });

  // ─── Exhaustive hardcode contract ──────────────────────────────────────
  //
  // The transcription-correction logic in evaluate-answer.utils.ts is
  // implemented as a long if-else chain over hardcoded (correct, student)
  // pairs — one branch per pair. The targeted tests above cover the
  // canonical paths and a curated sample of pairs; the suites below pin
  // down the FULL set so accidentally deleting a hardcode entry will
  // surface as a test failure rather than as a silent UX regression.
  //
  // The lists are kept in sync with the production source. If a new
  // hardcode is added there, it should be added here in the same order.
  describe('markWord — exhaustive hardcoded transcription contract', () => {
    describe('whole-answer "includes" hardcodes (per-word transcript join)', () => {
      it.each<[string, string]>([
        ['अमरस', 'अमररस'],
        ['कागज', 'कागज'],
        ['खटमल', 'खटमल'],
        ['टमटम', 'टमटम'],
        ['नटखट', 'नटखट'],
        ['बलगम', 'बलगम'],
        ['पीपल', 'पीपल'],
        ['परसो', 'परसो'],
        ['हलचल', 'हलचल'],
        ['हरदम', 'हरदम'],
        ['कलाकार', 'कलाकार'],
        ['दोपहर', 'दोपहर'],
        ['नाखून', 'नाखून'],
        ['भूगोल', 'भूगोल'],
        ['चौकीदार', 'चौकीदार'],
        ['कारखाना', 'कारखाना'],
        ['दालचीनी', 'दालचीनी'],
        ['नाशपाती', 'नाशपाती'],
        ['सोयाबीन', 'सोयाबीन'],
        ['तकिया', 'तकया'],
        ['तौलिया', 'तौलया'],
        ['करेला', 'करेला'],
        ['पुलिस', 'पुलइस'],
        ['अलमारी', 'अलमारी'],
        ['नाना', 'नाना'],
        ['मामा', 'मामा'],
        ['माता', 'माता'],
        ['दादा', 'दादा'],
        ['चाचा', 'चाचा'],
        ['केला', 'केला'],
        ['हलवा', 'हलवा'],
        ['हलवा', 'हलवह'],
        ['राजमा', 'राजमा'],
        ['बुलबुल', 'बुलबुल'],
        ['हाथी', 'हाथही'],
        ['अचकन', 'अचिकन'],
      ])(
        'correct=%s, studentAnswer.includes(%s) → true',
        (correct, student) => {
          expect(
            markWord({ correctAnswer: correct, studentAnswer: student }),
          ).toBe(true);
        },
      );
    });

    describe('per-word "equals" hardcodes (single transcript word)', () => {
      it.each<[string, string]>([
        ['ईख', 'एक'],
        ['दरवाज़ा', 'दरवाजा'],
        ['हथौड़ा', 'हथौड़ी'],
        ['हथौड़ी', 'हथौड़ा'],
        ['और', 'ओर'],
        ['ओर', 'और'],
        ['पढ़', 'पड़'],
        ['पड़', 'पढ़'],
        ['गए', 'गये'],
        ['गये', 'गए'],
        ['डर', 'दर'],
        ['दर', 'डर'],
        ['एक', '1'],
        ['एक', 'एकाएक'],
        ['दो', '2'],
        ['तीन', '3'],
        ['चार', '4'],
        ['पाँच', '5'],
        ['छह', '6'],
        ['सात', '7'],
        ['आठ', '8'],
        ['नौ', '9'],
        ['दस', '10'],
        ['बीस', '20'],
        ['तीस', '30'],
        ['चालीस', '40'],
        ['पचास', '50'],
        ['साठ', '60'],
        ['सत्तर', '70'],
        ['अस्सी', '80'],
        ['नब्बे', '90'],
        ['सौ', '100'],
        ['चख', 'चकाचक'],
        ['ठप', 'थपाथप'],
        ['तन', 'टनाटन'],
        ['फट', 'फटाफट'],
        ['भर', 'बराबर'],
        ['हट', 'हताहत'],
        ['गुण', 'गुन'],
        ['गुण', 'गुड़'],
        ['गुण', 'गुर'],
        ['गुण', 'गुड'],
        ['नहीं', 'नई'],
        ['नई', 'नहीं'],
        ['बच', 'बच्च'],
        ['हाँ', 'हां'],
        ['भय', 'भाई'],
        ['ऊन', 'उन'],
        ['उन', 'ऊन'],
        ['वह', 'वे'],
        ['वे', 'वह'],
        ['इडली', 'इटली'],
        ['सास', 'साँस'],
        ['सास', 'सांस'],
        ['ऐनक', 'एनक'],
        ['जनम', 'जन्म'],
        ['शकल', 'शक्ल'],
        ['समझ', 'समज'],
        ['ऋषभ', 'रिशभ'],
        ['ऋषि', 'रिशि'],
        ['वचन', 'बचन'],
        ['सिपाही', 'सिपाई'],
        ['महीना', 'महिना'],
        ['गणित', 'गनित'],
        ['औसत', 'ओसत'],
        ['औजार', 'ओजार'],
        ['औषधि', 'ओषधि'],
        ['ऐलान', 'एलान'],
        ['कैरम', 'केरम'],
        ['कापी', 'कॉपी'],
        ['काफी', 'कॉफी'],
        ['बहू', 'बहु'],
        ['पौधा', 'पौदा'],
        ['गोभी', 'गोबी'],
        ['कछुआ', 'कछुवा'],
        ['अखरोट', 'अकरोट'],
        ['मोबाइल', 'मोबाईल'],
        ['वीडियो', 'विडियो'],
        ['चोटी', 'छोटी'],
        ['चीनी', 'चिनी'],
        ['अधिकारी', 'अधिकरी'],
        ['सिख', 'सीख'],
        ['सिखा', 'सीखा'],
        ['पोछा', 'पोचा'],
        ['मैना', 'मेना'],
        ['नारियल', 'नरियल'],
        ['सुकून', 'सकून'],
        ['मसूर', 'मसुर'],
        ['सुबह', 'सुबा'],
        ['गई', 'गाय'],
        ['गई', 'गाई'],
        ['ऋषभ', 'रिसब'],
        ['ऋषभ', 'रिसभ'],
        ['बैठ', 'बेट'],
      ])('correct=%s, studentWord=%s → true', (correct, student) => {
        expect(
          markWord({ correctAnswer: correct, studentAnswer: student }),
        ).toBe(true);
      });
    });
  });

  describe('markLetter — exhaustive hardcoded transcription contract', () => {
    it.each<[string, string]>([
      ['म', 'माँ'],
      ['ह', 'हां'],
      ['ह', 'हाँ'],
      ['औ', 'ओह'],
      ['ओ', 'ओह'],
      ['आ', 'हाँ'],
      ['आ', 'हां'],
      ['आ', 'का'],
      ['ा', 'आ'],
      ['ा', 'हाँ'],
      ['ा', 'हां'],
      ['ा', 'का'],
      ['ि', 'इ'],
      ['ी', 'ई'],
      ['ु', 'उ'],
      ['ू', 'ऊ'],
      ['ृ', 'ऋ'],
      ['े', 'ए'],
      ['ै', 'ऐ'],
      ['ो', 'ओ'],
      ['ौ', 'औ'],
      ['ओ', 'आओ'],
      ['ऋ', 'री'],
      ['ऋ', 'रि'],
      ['श', 'शाह'],
      ['ष', 'शाह'],
      ['ा', 'बड़ा'],
      ['ी', 'बड़ी'],
      ['ए', 'ऐसे'],
      ['ब', 'वाह'],
      ['ख', 'हाँ'],
      ['ऐ', 'है'],
      ['ऐ', 'हाय'],
      ['छ', 'अच्छा'],
      ['ि', 'ई'],
      ['ी', 'इ'],
      ['ु', 'ऊ'],
      ['ू', 'उ'],
      ['ै', 'आए'],
      ['ऐ', 'आए'],
      ['औ', 'आओ'],
      ['ौ', 'आओ'],
      ['व', 'वाह'],
      ['भ', 'भाव'],
    ])('correct=%s, student=%s → true', (correct, student) => {
      expect(
        markLetter({ correctAnswer: correct, studentAnswer: student }),
      ).toBe(true);
    });
  });

  // ── Left-match negatives: each hardcoded rule's left operand matches but the
  // student answer does NOT, so the rule must NOT fire (result stays false via
  // the general algorithm). These kill the && → || and `if(cond)` → true
  // mutants on every hardcoded line, which the positive cases above cannot.
  describe('hardcoded rules do not fire when only the correct word matches', () => {
    it.each<string>([
      'अमरस',
      'कागज',
      'खटमल',
      'टमटम',
      'नटखट',
      'बलगम',
      'पीपल',
      'परसो',
      'हलचल',
      'हरदम',
      'कलाकार',
      'दोपहर',
      'नाखून',
      'भूगोल',
      'चौकीदार',
      'कारखाना',
      'दालचीनी',
      'नाशपाती',
      'सोयाबीन',
      'तकिया',
      'तौलिया',
      'करेला',
      'पुलिस',
      'अलमारी',
      'नाना',
      'मामा',
      'माता',
      'दादा',
      'चाचा',
      'केला',
      'हलवा',
      'राजमा',
      'बुलबुल',
      'हाथी',
      'अचकन',
      'ईख',
      'दरवाज़ा',
      'हथौड़ा',
      'हथौड़ी',
      'और',
      'ओर',
      'पढ़',
      'पड़',
      'गए',
      'गये',
      'डर',
      'दर',
      'एक',
      'दो',
      'तीन',
      'चार',
      'पाँच',
      'छह',
      'सात',
      'आठ',
      'नौ',
      'दस',
      'बीस',
      'तीस',
      'चालीस',
      'पचास',
      'साठ',
      'सत्तर',
      'अस्सी',
      'नब्बे',
      'सौ',
      'चख',
      'ठप',
      'तन',
      'फट',
      'भर',
      'हट',
      'गुण',
      'नहीं',
      'नई',
      'बच',
      'हाँ',
      'भय',
      'ऊन',
      'उन',
      'वह',
      'वे',
      'इडली',
      'सास',
      'ऐनक',
      'जनम',
      'शकल',
      'समझ',
      'ऋषभ',
      'ऋषि',
      'वचन',
      'सिपाही',
      'महीना',
      'गणित',
      'औसत',
      'औजार',
      'औषधि',
      'ऐलान',
      'कैरम',
      'कापी',
      'काफी',
      'बहू',
      'पौधा',
      'गोभी',
      'कछुआ',
      'अखरोट',
      'मोबाइल',
      'वीडियो',
      'चोटी',
      'चीनी',
      'अधिकारी',
      'सिख',
      'सिखा',
      'पोछा',
      'मैना',
      'नारियल',
      'सुकून',
      'मसूर',
      'सुबह',
      'गई',
      'बैठ',
    ])('markWord(correct=%s, student="q") → false', (correct) => {
      expect(markWord({ correctAnswer: correct, studentAnswer: 'q' })).toBe(
        false,
      );
    });

    it.each<string>([
      'म',
      'ह',
      'औ',
      'ओ',
      'आ',
      'ा',
      'ि',
      'ी',
      'ु',
      'ू',
      'ृ',
      'े',
      'ै',
      'ो',
      'ौ',
      'ऋ',
      'श',
      'ष',
      'ए',
      'ब',
      'ख',
      'ऐ',
      'छ',
      'व',
      'भ',
    ])('markLetter(correct=%s, student="q") → false', (correct) => {
      expect(markLetter({ correctAnswer: correct, studentAnswer: 'q' })).toBe(
        false,
      );
    });
  });

  // ── Algorithmic (non-hardcoded) paths ──────────────────────────────────────
  describe('markLetter — phoneme / conjunct algorithm', () => {
    it('matches a single consonant against a same-family consonant (markPhoneme base via sameFamily)', () => {
      // क and ख are in the same family; no hardcode covers this pair.
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'ख' })).toBe(true);
    });

    it('matches a single consonant + trailing schwa ā (markPhoneme slice branch)', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'का' })).toBe(
        true,
      );
    });

    it('rejects a single consonant followed by a non-ā matra', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: 'कि' })).toBe(
        false,
      );
    });

    it('rejects an empty student answer for a single phoneme', () => {
      expect(markLetter({ correctAnswer: 'क', studentAnswer: '' })).toBe(false);
    });

    it('two-consonant (conjunct) requires an exact match', () => {
      expect(markLetter({ correctAnswer: 'क्ष', studentAnswer: 'क्ष' })).toBe(
        true,
      );
    });

    it('two-consonant (conjunct) rejects a near miss', () => {
      expect(markLetter({ correctAnswer: 'क्ष', studentAnswer: 'कष' })).toBe(
        false,
      );
    });

    it('three+ consonants in the correct letter never match (cCount fallthrough)', () => {
      expect(markLetter({ correctAnswer: 'कमल', studentAnswer: 'कमल' })).toBe(
        false,
      );
    });
  });

  describe('detectInsertion — subsequence completion', () => {
    it('returns false for a longer answer that is NOT a supersequence (kills the inner return-false → true)', () => {
      // पपपप is longer than कमल but contains none of क/म/ल in order.
      expect(
        detectInsertion({ correctAnswer: 'कमल', studentAnswer: 'पपपप' }),
      ).toBe(false);
    });
  });

  // ── "includes" hardcodes must fire on a SUBSTRING match, not just an exact
  // word (the latter is also caught by the general per-word equality, leaving
  // the rule's own left operand untested). Appending a suffix keeps the target
  // a substring while defeating both the equality and the suffix-offset
  // algorithm, so only the hardcoded includes-rule can return true.
  describe('"includes" hardcodes fire on a substring (isolates the rule)', () => {
    it.each<[string, string]>([
      ['अमरस', 'अमररस'],
      ['कागज', 'कागज'],
      ['खटमल', 'खटमल'],
      ['टमटम', 'टमटम'],
      ['नटखट', 'नटखट'],
      ['बलगम', 'बलगम'],
      ['पीपल', 'पीपल'],
      ['परसो', 'परसो'],
      ['हलचल', 'हलचल'],
      ['हरदम', 'हरदम'],
      ['कलाकार', 'कलाकार'],
      ['दोपहर', 'दोपहर'],
      ['नाखून', 'नाखून'],
      ['भूगोल', 'भूगोल'],
      ['चौकीदार', 'चौकीदार'],
      ['कारखाना', 'कारखाना'],
      ['दालचीनी', 'दालचीनी'],
      ['नाशपाती', 'नाशपाती'],
      ['सोयाबीन', 'सोयाबीन'],
      ['तकिया', 'तकया'],
      ['तौलिया', 'तौलया'],
      ['करेला', 'करेला'],
      ['पुलिस', 'पुलइस'],
      ['अलमारी', 'अलमारी'],
      ['नाना', 'नाना'],
      ['मामा', 'मामा'],
      ['माता', 'माता'],
      ['दादा', 'दादा'],
      ['चाचा', 'चाचा'],
      ['केला', 'केला'],
      ['हलवा', 'हलवा'],
      ['हलवा', 'हलवह'],
      ['राजमा', 'राजमा'],
      ['बुलबुल', 'बुलबुल'],
      ['हाथी', 'हाथही'],
      ['अचकन', 'अचिकन'],
    ])('markWord(correct=%s, student contains %s) → true', (correct, sub) => {
      expect(
        markWord({ correctAnswer: correct, studentAnswer: sub + 'क' }),
      ).toBe(true);
    });
  });

  // ── Each "equals" hardcode also requires the SPECIFIC correct word: the same
  // student token against an unrelated (long, non-matching) correct answer must
  // not fire. Kills the per-rule "correct === X" → true mutants.
  describe('"equals" hardcodes require the matching correct word', () => {
    it.each<string>([
      'एक',
      'दरवाजा',
      'हथौड़ी',
      'हथौड़ा',
      'ओर',
      'और',
      'पड़',
      'पढ़',
      'गये',
      'गए',
      'दर',
      'डर',
      '1',
      'एकाएक',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '20',
      '30',
      '40',
      '50',
      '60',
      '70',
      '80',
      '90',
      '100',
      'चकाचक',
      'थपाथप',
      'टनाटन',
      'फटाफट',
      'बराबर',
      'हताहत',
      'गुन',
      'गुड़',
      'गुर',
      'गुड',
      'नई',
      'नहीं',
      'बच्च',
      'हां',
      'भाई',
      'उन',
      'ऊन',
      'वे',
      'वह',
      'इटली',
      'साँस',
      'सांस',
      'एनक',
      'जन्म',
      'शक्ल',
      'समज',
      'रिशभ',
      'रिशि',
      'बचन',
      'सिपाई',
      'महिना',
      'गनित',
      'ओसत',
      'ओजार',
      'ओषधि',
      'एलान',
      'केरम',
      'कॉपी',
      'कॉफी',
      'बहु',
      'पौदा',
      'गोबी',
      'कछुवा',
      'अकरोट',
      'मोबाईल',
      'विडियो',
      'छोटी',
      'चिनी',
      'अधिकरी',
      'सीख',
      'सीखा',
      'पोचा',
      'मेना',
      'नरियल',
      'सकून',
      'मसुर',
      'सुबा',
      'गाय',
      'गाई',
      'रिसब',
      'रिसभ',
      'बेट',
    ])('markWord(correct=<unrelated>, student=%s) → false', (student) => {
      expect(
        markWord({ correctAnswer: 'zzzzzzzzzz', studentAnswer: student }),
      ).toBe(false);
    });
  });
});
