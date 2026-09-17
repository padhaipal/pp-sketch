# onboarding-answer-match.ts — deterministic age / birth-month reading

Pure, no I/O. Used by OnboardingService twice: on the parent's transcripts
before any LLM call (`matchAge` / `matchMonth`; a value skips the LLM), and
on the LLM's reply (`readAge` / `readMonth`; the model's formatting is never
trusted). `MIN_AGE = 0`, `MAX_AGE = 1000` (re-exported by the machine).

## normalize(text)
NFD → drop nukta, chandrabindu → anusvara, drop visarga → NFC; lowercase;
Devanagari digits → ASCII; zero-width chars removed; `1,000` → `1000`;
punctuation → space; digits split from letters (`8yrs` → `8 yrs`). Every
lexicon entry goes through the same function, so variants (फ़रवरी/फरवरी,
पाँच/पांच, छः/छह) meet.

## Numbers 0–1000
- Digit runs (any size; out-of-range values still count, so "2019" blocks
  a match).
- A run of two or more single-digit words is one number read out digit by
  digit, as speech engines often write it: "पाँच शून्य" → 50, "नौ शून्य
  शून्य" → 900, "one zero" → 10 (checked before the tables below).
- Hindi 0–99 as an explicit table (Devanagari and romanized spellings) —
  irregular, so never composed.
- English 0–19 + tens (Latin and as hi-IN engines write it: एट, ट्वेंटी);
  tens + unit compose only within English ("twenty one", "ट्वेंटी वन").
- Hundreds/thousand: `[a|<1–99>] hundred|हंड्रेड|सौ|sau [and|एंड] [<1–99>]`,
  `[a|<1–999>] thousand|थाउजेंड|हज़ार|hazaar …`; "सौ" alone is 100; digits
  may multiply ("5 सौ" → 500).
- A spelling that means two numbers throws at module load.

## Months
English full and short names, Devanagari and romanized Hindi Gregorian
names, Hindu calendar months → the Gregorian month they mostly overlap in
the Indian national calendar (Chaitra 22 Mar–20 Apr → 4, Vaishakha 5,
Jyaistha 6, Ashadha 7, Shravana 8, Bhadra 9, Ashvin 10, Kartika 11,
Agrahayana 12, Pausha 1, Magha 2, Phalguna 3).

## Ambiguous words
Words that are also ordinary words — one, वन, सेवन, एक, ek, दो, do, teen,
tin, sat, sath, saath, bees, bis, tees, tis, char, bara, tera, sola, may,
mai, march, mar, jan, kartik/कार्तिक, sawan/सावन — count only when (a) the
whole text is answer words + context words + filler (जी, है, बस, hmm …) or
(b) they sit directly next to a context word (age: साल, वर्ष, बरस, उम्र,
saal, years, old …; month: महीना, माह, जन्म, पैदा, month, born …). A
multi-word expression ("एक सौ") is never ambiguous. `strict: false` (LLM
replies) skips the rule.

## Deciding
Per text: age → the one distinct number (0–1000), 'none', or 'conflict'
(two numbers, or out of range). Month → the one month name if any (a name
beats numbers: "8 मार्च" → 3), else the one number 1–12, else
'none'/'conflict'. Across transcripts: any conflict → null; otherwise the
single value all non-'none' readings agree on, else null.
