import {
  MAX_AGE,
  matchAge,
  matchMonth,
  normalize,
  numbersIn,
  readAge,
  readMonth,
} from './onboarding-answer-match';

// Spellings below are written out independently of the implementation's
// tables so every number 0–1000 is checked against a second source.
const HI =
  'शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरेपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरेसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उनासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे'.split(
    ' ',
  );
const HI_LATIN =
  'shunya ek do teen char paanch chhe saat aath nau das gyarah barah terah chaudah pandrah solah satrah atharah unnis bees ikkis bais teis chaubis pachchis chhabbis sattais atthais untis tees iktis battis taintis chauntis paintis chhattis saintis adtis untalis chalis iktalis bayalis taintalis chawalis paintalis chhiyalis saintalis adtalis unchas pachas ikyavan baavan tirepan chauvan pachpan chhappan sattavan atthavan unsath saath iksath baasath tirsath chaunsath painsath chhiyasath sadsath adsath unhattar sattar ikhattar bahattar tihattar chauhattar pachhattar chhihattar sathattar athhattar unasi assi ikyasi bayasi tirasi chaurasi pachasi chhiyasi sattasi atthasi navasi nabbe ikyanave baanave tiranave chauranave pachanave chhiyanave sattanave atthanave ninyanave'.split(
    ' ',
  );
const EN_UNITS =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
    ' ',
  );
const EN_TENS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
];
const EN_DEVA_UNITS =
  'जीरो वन टू थ्री फोर फाइव सिक्स सेवन एट नाइन टेन इलेवन ट्वेल्व थर्टीन फोर्टीन फिफ्टीन सिक्सटीन सेवनटीन एटीन नाइनटीन'.split(
    ' ',
  );
const EN_DEVA_TENS = [
  '',
  '',
  'ट्वेंटी',
  'थर्टी',
  'फोर्टी',
  'फिफ्टी',
  'सिक्सटी',
  'सेवंटी',
  'एटी',
  'नाइंटी',
];

function english(
  n: number,
  units: string[],
  tens: string[],
  hundred: string,
  thousand: string,
  and: string | null,
): string {
  const below100 = (v: number) =>
    v < 20
      ? units[v]
      : tens[Math.floor(v / 10)] + (v % 10 ? ` ${units[v % 10]}` : '');
  if (n === 1000) return `${units[1]} ${thousand}`;
  if (n < 100) return below100(n);
  const head = `${units[Math.floor(n / 100)]} ${hundred}`;
  const rest = n % 100;
  return rest ? `${head}${and ? ` ${and}` : ''} ${below100(rest)}` : head;
}

function hindi(
  n: number,
  words: string[],
  hundred: string,
  thousand: string,
): string {
  if (n === 1000) return `${words[1]} ${thousand}`;
  if (n < 100) return words[n];
  const rest = n % 100;
  return `${words[Math.floor(n / 100)]} ${hundred}${rest ? ` ${words[rest]}` : ''}`;
}

const FORMS: Array<[string, (n: number) => string]> = [
  ['digits', (n) => String(n)],
  [
    'Devanagari digits',
    (n) => String(n).replace(/\d/g, (d) => '०१२३४५६७८९'[Number(d)]),
  ],
  [
    'English words',
    (n) => english(n, EN_UNITS, EN_TENS, 'hundred', 'thousand', 'and'),
  ],
  [
    'English words, no "and"',
    (n) => english(n, EN_UNITS, EN_TENS, 'hundred', 'thousand', null),
  ],
  [
    'English in Devanagari',
    (n) => english(n, EN_DEVA_UNITS, EN_DEVA_TENS, 'हंड्रेड', 'थाउजेंड', null),
  ],
  ['Hindi', (n) => hindi(n, HI, 'सौ', 'हज़ार')],
  ['romanized Hindi', (n) => hindi(n, HI_LATIN, 'sau', 'hazaar')],
];

describe('matchAge — every number 0–1000 in every form', () => {
  const all = Array.from({ length: MAX_AGE + 1 }, (_, n) => n);
  it.each(FORMS)('%s', (_form, spell) => {
    const misses = all.filter((n) => matchAge([`${spell(n)} साल`]) !== n);
    expect(misses).toEqual([]);
    // Bare answers too (ambiguous words like एक / one count when alone).
    const bareMisses = all.filter((n) => matchAge([spell(n)]) !== n);
    expect(bareMisses).toEqual([]);
  });
});

describe('matchAge — variants and wrappers', () => {
  it.each([
    [['पांच'], 5],
    [['छः साल'], 6],
    [['छे'], 6],
    [['chha saal'], 6],
    [['ट्वेन्टी वन'], 21],
    [['twenty-one years old'], 21],
    [['a hundred and five'], 105],
    [['सौ'], 100],
    [['5 सौ'], 500],
    [['1,000'], 1000],
    [['8yrs'], 8],
    [['मेरी बेटी आठ साल की है'], 8],
    [['जी आठ'], 8],
    [['दो साल'], 2],
    [['साढ़े सात साल'], 7],
    // Several engines agreeing, in different forms, with an empty reading.
    [['आठ', '8', 'eight', ''], 8],
    // Read out digit by digit (Azure), beside the number word (Sarvam).
    [['पचास', 'पाँच शून्य।'], 50],
    [['नो सो', 'नौ शून्य शून्य।'], 900],
    [['एक शून्य'], 10],
    [['one zero'], 10],
    [['वन जीरो'], 10],
  ])('%j → %i', (texts, expected) => {
    expect(matchAge(texts)).toBe(expected);
  });

  it.each([
    [[]],
    [['']],
    [['पता नहीं']],
    // Ambiguous words that are not answers.
    [['एक मिनट रुकिए']],
    [['मुझे दो']],
    [['I do not know']],
    [['that one']],
    // Two candidates, disagreement, out of range.
    [['आठ या नौ']],
    [['8 साल 6 महीने']],
    [['आठ', 'नौ']],
    [['1001']],
    [['two thousand']],
    [['2019']],
    // Digit by digit but over MAX_AGE.
    [['एक दो शून्य शून्य']],
  ])('%j → null (ask the LLM)', (texts) => {
    expect(matchAge(texts)).toBeNull();
  });
});

describe('matchMonth', () => {
  const NAMES: Array<[number, string[]]> = [
    [1, ['January', 'jan', 'जनवरी', 'janvari', 'पौष', 'पूस', 'paush']],
    [2, ['February', 'feb', 'फ़रवरी', 'फरवरी', 'farvari', 'माघ', 'magh']],
    [3, ['March', 'मार्च', 'फाल्गुन', 'फागुन', 'phagun']],
    [4, ['April', 'apr', 'अप्रैल', 'aprail', 'चैत्र', 'चैत', 'chaitra']],
    [5, ['May', 'मई', 'वैशाख', 'बैसाख', 'baisakh']],
    [6, ['June', 'जून', 'ज्येष्ठ', 'जेठ', 'jeth']],
    [7, ['July', 'जुलाई', 'julai', 'आषाढ़', 'ashadh']],
    [8, ['August', 'aug', 'अगस्त', 'agast', 'श्रावण', 'सावन']],
    [
      9,
      ['September', 'sept', 'सितंबर', 'सितम्बर', 'भाद्रपद', 'भादों', 'bhado'],
    ],
    [10, ['October', 'oct', 'अक्टूबर', 'अक्तूबर', 'आश्विन', 'क्वार', 'kwar']],
    [11, ['November', 'nov', 'नवंबर', 'नवम्बर', 'कार्तिक', 'kartik']],
    [
      12,
      ['December', 'dec', 'दिसंबर', 'दिसम्बर', 'मार्गशीर्ष', 'अगहन', 'agahan'],
    ],
  ];
  it.each(NAMES)('month %i from its names', (month, names) => {
    for (const name of names)
      expect([name, matchMonth([name])]).toEqual([name, month]);
  });

  it.each(Array.from({ length: 12 }, (_, i) => i + 1))(
    'month %i from every number form',
    (month) => {
      for (const [form, spell] of FORMS) {
        expect([form, matchMonth([spell(month)])]).toEqual([form, month]);
      }
    },
  );

  it.each([
    [['8 मार्च'], 3],
    [['मार्च में पैदा हुआ'], 3],
    [['मार्च', '3'], 3],
    [['may month'], 5],
    [['पाँच महीना'], 5],
  ])('%j → %i', (texts, expected) => {
    expect(matchMonth(texts)).toBe(expected);
  });

  it.each([
    [['पता नहीं']],
    [['I may not know']],
    [['मार्च या अप्रैल']],
    [['मार्च', 'अप्रैल']],
    [['13']],
    [['3 या 4']],
    [['kartik ka janm']],
  ])('%j → null (ask the LLM)', (texts) => {
    expect(matchMonth(texts)).toBeNull();
  });
});

describe('reading the LLM reply', () => {
  it.each([
    ['8', 8],
    ['Age: eight', 8],
    ['one', 1],
    ['0', 0],
    ['1000', 1000],
    ['UNINTELLIGIBLE', null],
    ['1001', null],
    ['7 or 8', null],
  ])('readAge(%j) → %p', (text, expected) => {
    expect(readAge(text)).toBe(expected);
  });

  it.each([
    ['3', 3],
    ['March (3)', 3],
    ['may', 5],
    ['NONE', null],
    ['0', null],
    ['April or May', null],
  ])('readMonth(%j) → %p', (text, expected) => {
    expect(readMonth(text)).toBe(expected);
  });
});

describe('normalize', () => {
  it('merges spelling variants and splits digits from letters', () => {
    expect(normalize('फ़रवरी पाँच छः 8yrs 1,000।')).toBe(
      'फरवरी पांच छ 8 yrs 1000',
    );
  });

  it('numbersIn without the ambiguity rule reads every number', () => {
    expect(numbersIn('एक मिनट', { strict: false })).toEqual([1]);
    expect(numbersIn('एक मिनट')).toEqual([]);
  });
});
