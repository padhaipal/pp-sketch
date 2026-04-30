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

    /* -- ण / न / र families: ण equates to both न and र, but न and र do
       not transitively equate (FAMILIES has ['ण','न'] and ['ण','र'] as
       separate rows). -- */
    it('treats ण and न as the same family', () => {
      expect(markWord({ correctAnswer: 'णन', studentAnswer: 'नण' })).toBe(true);
    });

    it('treats ण and र as the same family', () => {
      expect(markWord({ correctAnswer: 'णर', studentAnswer: 'रण' })).toBe(true);
    });

    it('does NOT treat न and र as the same family', () => {
      expect(markWord({ correctAnswer: 'नर', studentAnswer: 'रन' })).toBe(
        false,
      );
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

    /* -- bare matra (cCount === 0) edge case -- */
    it('returns false for a bare matra correct without a hardcode (e.g. ृ vs ृ)', () => {
      // Exposes that markLetter cannot handle the trivial self-match for
      // a matra-only correctAnswer that lacks a hardcoded entry.
      expect(markLetter({ correctAnswer: 'ृ', studentAnswer: 'ृ' })).toBe(
        false,
      );
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
});
