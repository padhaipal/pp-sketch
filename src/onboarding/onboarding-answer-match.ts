// Deterministic reading of spoken numbers and month names, used twice by
// OnboardingService: first on the parent's transcripts (a clear answer skips
// the LLM call), then on the LLM's own reply (never trust its formatting).
//
// Covers digits (ASCII and Devanagari) and number words 0–1000 in English
// (Latin script and as hi-IN speech engines write it in Devanagari), Hindi in
// Devanagari and romanized Hindi, plus English, Hindi and Hindu-calendar month
// names. Pure; no I/O.

export const MIN_AGE = 0;
export const MAX_AGE = 1000;

// ─── Normalization ──────────────────────────────────────────────────────────

const DEVANAGARI_DIGITS = '०१२३४५६७८९';

// Lowercase, Devanagari digits → ASCII, spelling variants merged (nukta
// dropped, chandrabindu → anusvara, visarga dropped), punctuation → space,
// digits split from letters ("8yrs" → "8 yrs", "1,000" → "1000").
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\u093C/g, '')
    .replace(/\u0901/g, '\u0902')
    .replace(/\u0903/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)))
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/(\d)(?=[^\d\s])|([^\d\s])(?=\d)/gu, '$1$2 ')
    .trim();
}

function tokens(text: string): string[] {
  const normalized = normalize(text);
  return normalized ? normalized.split(/\s+/) : [];
}

// ─── Lexicon ────────────────────────────────────────────────────────────────

type Family = 'en' | 'hi';
interface NumberWord {
  value: number;
  family: Family;
  tens: boolean;
}

// Hindi 0–100 (irregular, so listed), Devanagari then romanized spellings.
const HINDI: Array<[number, string[]]> = [
  [0, ['शून्य', 'shunya', 'shoonya', 'sunya']],
  [1, ['एक', 'ek']],
  [2, ['दो', 'do']],
  [3, ['तीन', 'teen', 'tin']],
  [4, ['चार', 'char', 'chaar']],
  [5, ['पाँच', 'पांच', 'panch', 'paanch', 'paach']],
  [
    6,
    [
      'छह',
      'छः',
      'छे',
      'छै',
      'छेह',
      'chhe',
      'che',
      'chhah',
      'chah',
      'chha',
      'chhai',
      'chhey',
    ],
  ],
  [7, ['सात', 'saat', 'sat']],
  [8, ['आठ', 'aath', 'ath', 'aat']],
  [9, ['नौ', 'nau', 'nao']],
  [10, ['दस', 'das', 'dus']],
  [11, ['ग्यारह', 'ग्यारा', 'gyarah', 'gyaarah', 'gyara', 'gyaraa']],
  [12, ['बारह', 'बारा', 'barah', 'baarah', 'bara', 'baara']],
  [13, ['तेरह', 'तेरा', 'terah', 'tera']],
  [14, ['चौदह', 'चौदा', 'chaudah', 'chauda', 'choda', 'chodah']],
  [15, ['पंद्रह', 'पन्द्रह', 'पंद्रा', 'pandrah', 'pandra', 'pandhra']],
  [16, ['सोलह', 'सोला', 'solah', 'sola']],
  [17, ['सत्रह', 'सत्रा', 'satrah', 'satra']],
  [18, ['अठारह', 'अठारा', 'atharah', 'athara', 'attharah']],
  [19, ['उन्नीस', 'unnis', 'unees', 'unnees']],
  [20, ['बीस', 'bees', 'bis']],
  [21, ['इक्कीस', 'ikkis', 'ikkees']],
  [22, ['बाईस', 'bais', 'baais', 'baees']],
  [23, ['तेईस', 'teis', 'teyis']],
  [24, ['चौबीस', 'chaubis', 'chaubees', 'chobis']],
  [25, ['पच्चीस', 'pachchis', 'pachis', 'pacchis', 'pachees']],
  [26, ['छब्बीस', 'chhabbis', 'chabbis', 'chhabbees']],
  [27, ['सत्ताईस', 'sattais', 'sattaees']],
  [28, ['अट्ठाईस', 'अठाईस', 'atthais', 'athais', 'atthaees']],
  [29, ['उनतीस', 'उन्तीस', 'untis', 'unatees', 'untees']],
  [30, ['तीस', 'tees', 'tis']],
  [31, ['इकतीस', 'इकत्तीस', 'iktis', 'ikattis', 'iktees']],
  [32, ['बत्तीस', 'battis', 'battees']],
  [33, ['तैंतीस', 'taintis', 'tentis', 'taintees']],
  [34, ['चौंतीस', 'chauntis', 'chontis', 'chauntees']],
  [35, ['पैंतीस', 'paintis', 'paintees']],
  [36, ['छत्तीस', 'chhattis', 'chattis', 'chhattees']],
  [37, ['सैंतीस', 'saintis', 'saintees']],
  [38, ['अड़तीस', 'adtis', 'adtees', 'artis']],
  [39, ['उनतालीस', 'untalis', 'unchalis', 'untalees']],
  [40, ['चालीस', 'chalis', 'chaalis', 'chalees']],
  [41, ['इकतालीस', 'iktalis', 'iktalees']],
  [42, ['बयालीस', 'bayalis', 'bayalees']],
  [43, ['तैंतालीस', 'taintalis', 'taintalees']],
  [44, ['चवालीस', 'चौवालीस', 'chawalis', 'chauvalis', 'chaualis', 'chavalees']],
  [45, ['पैंतालीस', 'paintalis', 'paintalees']],
  [46, ['छियालीस', 'chhiyalis', 'chiyalis', 'chhiyalees']],
  [47, ['सैंतालीस', 'saintalis', 'saintalees']],
  [48, ['अड़तालीस', 'adtalis', 'artalis', 'adtalees']],
  [49, ['उनचास', 'unchas', 'unchaas']],
  [50, ['पचास', 'pachas', 'pachaas']],
  [51, ['इक्यावन', 'ikyavan', 'ikyawan', 'ikkyavan']],
  [52, ['बावन', 'baavan', 'bavan', 'bawan']],
  [53, ['तिरेपन', 'तिरपन', 'tirepan', 'tirpan']],
  [54, ['चौवन', 'chauvan', 'chauwan', 'chowan']],
  [55, ['पचपन', 'pachpan']],
  [56, ['छप्पन', 'chhappan', 'chappan']],
  [57, ['सत्तावन', 'sattavan', 'sattawan']],
  [58, ['अट्ठावन', 'अठावन', 'atthavan', 'athawan', 'atthawan']],
  [59, ['उनसठ', 'unsath', 'unsaath']],
  [60, ['साठ', 'saath', 'sath']],
  [61, ['इकसठ', 'iksath', 'ikasath']],
  [62, ['बासठ', 'baasath', 'basath']],
  [63, ['तिरेसठ', 'तिरसठ', 'tirsath', 'tiresath']],
  [64, ['चौंसठ', 'chaunsath', 'chausath']],
  [65, ['पैंसठ', 'painsath']],
  [66, ['छियासठ', 'chhiyasath', 'chiyasath']],
  [67, ['सड़सठ', 'सरसठ', 'sadsath', 'sarsath']],
  [68, ['अड़सठ', 'adsath', 'arsath']],
  [69, ['उनहत्तर', 'unhattar']],
  [70, ['सत्तर', 'sattar']],
  [71, ['इकहत्तर', 'ikhattar', 'ikahattar']],
  [72, ['बहत्तर', 'bahattar']],
  [73, ['तिहत्तर', 'tihattar']],
  [74, ['चौहत्तर', 'chauhattar']],
  [75, ['पचहत्तर', 'pachhattar', 'pachattar']],
  [76, ['छिहत्तर', 'chhihattar', 'chihattar']],
  [77, ['सतहत्तर', 'sathattar', 'satahattar']],
  [78, ['अठहत्तर', 'athhattar', 'athattar']],
  [79, ['उनासी', 'उन्यासी', 'unasi', 'unyasi']],
  [80, ['अस्सी', 'assi']],
  [81, ['इक्यासी', 'ikyasi', 'ikyaasi']],
  [82, ['बयासी', 'bayasi', 'bayaasi']],
  [83, ['तिरासी', 'tirasi', 'tiraasi']],
  [84, ['चौरासी', 'chaurasi', 'chauraasi']],
  [85, ['पचासी', 'pachasi', 'pachaasi']],
  [86, ['छियासी', 'chhiyasi', 'chiyasi']],
  [87, ['सत्तासी', 'sattasi', 'sattaasi']],
  [88, ['अट्ठासी', 'अठासी', 'atthasi', 'athasi', 'atthaasi']],
  [89, ['नवासी', 'navasi', 'nawasi']],
  [90, ['नब्बे', 'nabbe']],
  [91, ['इक्यानवे', 'ikyanave', 'ikyaanve']],
  [92, ['बानवे', 'baanave', 'banave', 'baanve']],
  [93, ['तिरानवे', 'tiranave', 'tiraanve']],
  [94, ['चौरानवे', 'chauranave', 'chauraanve']],
  [95, ['पचानवे', 'pachanave', 'pachaanve']],
  [96, ['छियानवे', 'chhiyanave', 'chiyaanve']],
  [97, ['सत्तानवे', 'sattanave', 'sattaanve']],
  [98, ['अट्ठानवे', 'atthanave', 'atthaanve']],
  [99, ['निन्यानवे', 'निन्यानबे', 'ninyanave', 'ninyaanve', 'ninyanbe']],
];

// English 0–19 and tens, Latin script then as hi-IN engines write them.
const ENGLISH_UNITS: Array<[number, string[]]> = [
  [0, ['zero', 'जीरो', 'ज़ीरो']],
  [1, ['one', 'वन']],
  [2, ['two', 'टू']],
  [3, ['three', 'थ्री']],
  [4, ['four', 'फोर', 'फ़ोर']],
  [5, ['five', 'फाइव', 'फाईव']],
  [6, ['six', 'सिक्स']],
  [7, ['seven', 'सेवन', 'सेवेन']],
  [8, ['eight', 'एट', 'ऐट', 'एइट']],
  [9, ['nine', 'नाइन', 'नाईन']],
  [10, ['ten', 'टेन']],
  [11, ['eleven', 'इलेवन', 'इलेवेन']],
  [12, ['twelve', 'ट्वेल्व', 'ट्वेल्व्']],
  [13, ['thirteen', 'थर्टीन']],
  [14, ['fourteen', 'फोर्टीन', 'फ़ोर्टीन']],
  [15, ['fifteen', 'फिफ्टीन', 'फ़िफ़्टीन']],
  [16, ['sixteen', 'सिक्सटीन']],
  [17, ['seventeen', 'सेवनटीन', 'सेवेनटीन']],
  [18, ['eighteen', 'एटीन', 'ऐटीन']],
  [19, ['nineteen', 'नाइनटीन']],
];
const ENGLISH_TENS: Array<[number, string[]]> = [
  [20, ['twenty', 'ट्वेंटी', 'ट्वेन्टी']],
  [30, ['thirty', 'थर्टी']],
  [40, ['forty', 'fourty', 'फोर्टी', 'फॉर्टी']],
  [50, ['fifty', 'फिफ्टी', 'फ़िफ़्टी']],
  [60, ['sixty', 'सिक्सटी']],
  [70, ['seventy', 'सेवंटी', 'सेवेंटी', 'सेवन्टी']],
  [80, ['eighty', 'एटी', 'ऐटी']],
  [90, ['ninety', 'नाइंटी', 'नाइन्टी']],
];

const HUNDRED = new Set(
  ['hundred', 'हंड्रेड', 'हन्ड्रेड', 'सौ', 'sau'].map(normalize),
);
const THOUSAND = new Set(
  [
    'thousand',
    'थाउजेंड',
    'थाउज़ेंड',
    'थाउसेंड',
    'हज़ार',
    'हजार',
    'hazar',
    'hazaar',
    'hajar',
    'hajaar',
  ].map(normalize),
);
const AND = new Set(['and', 'एंड', 'ऐंड'].map(normalize));
const ARTICLE = new Set(['a', 'an']);

const NUMBER_WORDS = new Map<string, NumberWord>();
function addWords(
  table: Array<[number, string[]]>,
  family: Family,
  tens: boolean,
): void {
  for (const [value, spellings] of table) {
    for (const spelling of spellings) {
      const key = normalize(spelling);
      const existing = NUMBER_WORDS.get(key);
      if (existing && existing.value !== value) {
        throw new Error(
          `number word "${key}" means both ${existing.value} and ${value}`,
        );
      }
      NUMBER_WORDS.set(key, { value, family, tens });
    }
  }
}
addWords(HINDI, 'hi', false);
addWords(ENGLISH_UNITS, 'en', false);
addWords(ENGLISH_TENS, 'en', true);

// Gregorian months (English, Devanagari, romanized Hindi) and Hindu calendar
// months mapped to the Gregorian month they mostly overlap in the Indian
// national calendar (Chaitra 22 Mar–20 Apr → April … Phalguna → March).
const MONTHS: Array<[number, string[]]> = [
  [
    1,
    [
      'january',
      'jan',
      'जनवरी',
      'जनवरि',
      'janvari',
      'janwari',
      'पौष',
      'पूस',
      'paush',
      'pausha',
      'poos',
    ],
  ],
  [
    2,
    [
      'february',
      'febuary',
      'feb',
      'फ़रवरी',
      'फरवरी',
      'फेब्रुअरी',
      'farvari',
      'farwari',
      'माघ',
      'magh',
      'magha',
    ],
  ],
  [
    3,
    [
      'march',
      'mar',
      'मार्च',
      'फाल्गुन',
      'फागुन',
      'phalgun',
      'phagun',
      'falgun',
    ],
  ],
  [
    4,
    [
      'april',
      'apr',
      'अप्रैल',
      'अप्रेल',
      'अप्रील',
      'aprail',
      'aprel',
      'चैत्र',
      'चैत',
      'chaitra',
      'chait',
    ],
  ],
  [
    5,
    [
      'may',
      'मई',
      'mai',
      'वैशाख',
      'बैसाख',
      'बैशाख',
      'वैसाख',
      'vaishakh',
      'vaisakh',
      'baisakh',
    ],
  ],
  [
    6,
    [
      'june',
      'jun',
      'जून',
      'joon',
      'ज्येष्ठ',
      'जेठ',
      'जेष्ठ',
      'jyeshtha',
      'jyeshta',
      'jeth',
    ],
  ],
  [
    7,
    [
      'july',
      'jul',
      'जुलाई',
      'जुलै',
      'julai',
      'आषाढ़',
      'आषाढ',
      'असाढ़',
      'ashadh',
      'asadh',
      'ashadha',
    ],
  ],
  [
    8,
    [
      'august',
      'aug',
      'अगस्त',
      'agast',
      'श्रावण',
      'सावन',
      'shravan',
      'shravana',
      'sawan',
      'saawan',
    ],
  ],
  [
    9,
    [
      'september',
      'sept',
      'sep',
      'सितंबर',
      'सितम्बर',
      'सेप्टेंबर',
      'सेप्टेम्बर',
      'sitambar',
      'sitamber',
      'भाद्रपद',
      'भादो',
      'भादों',
      'bhadrapad',
      'bhado',
      'bhadon',
    ],
  ],
  [
    10,
    [
      'october',
      'oct',
      'अक्टूबर',
      'अक्तूबर',
      'ऑक्टोबर',
      'aktubar',
      'aktoobar',
      'आश्विन',
      'अश्विन',
      'क्वार',
      'कुआर',
      'ashwin',
      'ashvin',
      'kwar',
      'kuar',
    ],
  ],
  [
    11,
    [
      'november',
      'nov',
      'नवंबर',
      'नवम्बर',
      'नोवेंबर',
      'navambar',
      'navamber',
      'कार्तिक',
      'कातिक',
      'kartik',
      'kartika',
    ],
  ],
  [
    12,
    [
      'december',
      'dec',
      'दिसंबर',
      'दिसम्बर',
      'डिसेंबर',
      'डिसेम्बर',
      'disambar',
      'disamber',
      'मार्गशीर्ष',
      'अगहन',
      'margashirsha',
      'agahan',
      'aghan',
    ],
  ],
];
const MONTH_WORDS = new Map<string, number>();
for (const [month, spellings] of MONTHS) {
  for (const spelling of spellings) MONTH_WORDS.set(normalize(spelling), month);
}

// Words that are also ordinary words ("one", एक as "a", दो as "give", "do",
// "teen", "may", मैं romanized as "mai", "march", a boy named Kartik …). They
// count only when the whole reply is number/month words, or when they sit
// next to a context word ("दो साल", "may month").
const AMBIGUOUS = new Set(
  [
    'one',
    'वन',
    'सेवन',
    'एक',
    'ek',
    'दो',
    'do',
    'teen',
    'tin',
    'sat',
    'sath',
    'saath',
    'bees',
    'bis',
    'tees',
    'tis',
    'char',
    'bara',
    'tera',
    'sola',
    'may',
    'mai',
    'march',
    'mar',
    'jan',
    'kartik',
    'कार्तिक',
    'sawan',
    'सावन',
  ].map(normalize),
);
const AGE_CONTEXT = new Set(
  [
    'साल',
    'सालों',
    'वर्ष',
    'बरस',
    'बर्ष',
    'उम्र',
    'इयर',
    'इयर्स',
    'ईयर',
    'ईयर्स',
    'ओल्ड',
    'saal',
    'sal',
    'varsh',
    'baras',
    'umar',
    'umra',
    'year',
    'years',
    'yr',
    'yrs',
    'old',
    'age',
  ].map(normalize),
);
const MONTH_CONTEXT = new Set(
  [
    'महीना',
    'महीने',
    'माह',
    'मास',
    'जन्म',
    'जनम',
    'पैदा',
    'बर्थ',
    'mahina',
    'mahine',
    'janm',
    'janam',
    'month',
    'born',
    'birth',
  ].map(normalize),
);

// Words a bare answer is often wrapped in ("जी आठ", "hmm eight") — they do
// not make an ambiguous word ordinary.
const FILLER = new Set(
  [
    'जी',
    'है',
    'हैं',
    'बस',
    'हम्म',
    'ji',
    'hai',
    'hain',
    'bas',
    'hmm',
    'umm',
  ].map(normalize),
);

// ─── Parsing ────────────────────────────────────────────────────────────────

interface Span {
  value: number;
  start: number;
  end: number; // exclusive
}

function belowHundred(toks: string[], i: number): Span | null {
  const tok = toks[i];
  if (tok === undefined) return null;
  if (/^\d+$/.test(tok)) {
    return { value: parseInt(tok, 10), start: i, end: i + 1 };
  }
  const word = NUMBER_WORDS.get(tok);
  if (!word) return null;
  const next = NUMBER_WORDS.get(toks[i + 1] ?? '');
  if (
    word.tens &&
    next &&
    next.family === 'en' &&
    !next.tens &&
    next.value >= 1 &&
    next.value <= 9
  ) {
    return { value: word.value + next.value, start: i, end: i + 2 };
  }
  return { value: word.value, start: i, end: i + 1 };
}

// One number expression starting at i: "8", "twenty one", "एक सौ पाँच",
// "a hundred and five", "सौ", "one thousand", "5 सौ".
function numberAt(toks: string[], i: number): Span | null {
  let pos = i;
  if (
    ARTICLE.has(toks[pos]) &&
    (HUNDRED.has(toks[pos + 1]) || THOUSAND.has(toks[pos + 1]))
  ) {
    pos += 1;
  }
  let value: number;
  const head = belowHundred(toks, pos);
  if (head) {
    value = head.value;
    pos = head.end;
  } else if (HUNDRED.has(toks[pos]) || THOUSAND.has(toks[pos])) {
    value = 1;
  } else {
    return null;
  }
  const scaled = (
    scale: Set<string>,
    factor: number,
    maxMultiplier: number,
  ) => {
    if (scale.has(toks[pos]) && value >= 1 && value <= maxMultiplier) {
      value *= factor;
      pos += 1;
      return true;
    }
    return false;
  };
  if (scaled(THOUSAND, 1000, 999) || scaled(HUNDRED, 100, 99)) {
    const base = value;
    if (base >= 1000 && HUNDRED.has(toks[pos + 1] ?? '')) {
      const hundreds = belowHundred(toks, pos);
      if (hundreds && hundreds.value >= 1 && hundreds.value <= 9) {
        value += hundreds.value * 100;
        pos = hundreds.end + 1;
      }
    }
    const afterAnd = AND.has(toks[pos]) ? pos + 1 : pos;
    const rest = belowHundred(toks, afterAnd);
    if (rest && rest.value >= 1 && rest.value <= 99) {
      value += rest.value;
      pos = rest.end;
    }
  }
  return { value, start: i, end: pos };
}

function isAmbiguous(toks: string[], span: Span): boolean {
  return span.end - span.start === 1 && AMBIGUOUS.has(toks[span.start]);
}

function supported(
  toks: string[],
  span: Span,
  context: Set<string>,
  isAnswerWord: (tok: string) => boolean,
): boolean {
  if (!isAmbiguous(toks, span)) return true;
  if (context.has(toks[span.start - 1]) || context.has(toks[span.end])) {
    return true;
  }
  return toks.every((t) => isAnswerWord(t) || context.has(t) || FILLER.has(t));
}

const isNumberWord = (t: string) =>
  /^\d+$/.test(t) ||
  NUMBER_WORDS.has(t) ||
  HUNDRED.has(t) ||
  THOUSAND.has(t) ||
  AND.has(t) ||
  ARTICLE.has(t);

// Distinct numbers mentioned in one text. `strict` applies the ambiguous-word
// rule (transcripts); the LLM's reply is read without it.
export function numbersIn(
  text: string,
  { strict = true, context = AGE_CONTEXT } = {},
): number[] {
  const toks = tokens(text);
  const found = new Set<number>();
  let i = 0;
  while (i < toks.length) {
    const span = numberAt(toks, i);
    if (!span) {
      i += 1;
      continue;
    }
    if (!strict || supported(toks, span, context, isNumberWord)) {
      found.add(span.value);
    }
    i = span.end;
  }
  return [...found];
}

// Distinct months named in one text (month words only, not numbers).
export function monthNamesIn(text: string, { strict = true } = {}): number[] {
  const toks = tokens(text);
  const found = new Set<number>();
  toks.forEach((tok, i) => {
    const month = MONTH_WORDS.get(tok);
    if (month === undefined) return;
    const span = { value: month, start: i, end: i + 1 };
    if (
      !strict ||
      supported(
        toks,
        span,
        MONTH_CONTEXT,
        (t) => MONTH_WORDS.has(t) || isNumberWord(t),
      )
    ) {
      found.add(month);
    }
  });
  return [...found];
}

type Reading = number | 'none' | 'conflict';

function agree(readings: Reading[]): number | null {
  if (readings.includes('conflict')) return null;
  const values = new Set(readings.filter((r): r is number => r !== 'none'));
  return values.size === 1 ? [...values][0] : null;
}

function ageReading(text: string, strict: boolean): Reading {
  const numbers = numbersIn(text, { strict });
  if (numbers.length === 0) return 'none';
  if (numbers.length > 1) return 'conflict';
  return numbers[0] >= MIN_AGE && numbers[0] <= MAX_AGE
    ? numbers[0]
    : 'conflict';
}

function monthReading(text: string, strict: boolean): Reading {
  const names = monthNamesIn(text, { strict });
  if (names.length > 1) return 'conflict';
  if (names.length === 1) return names[0];
  const numbers = numbersIn(text, { strict, context: MONTH_CONTEXT });
  if (numbers.length === 0) return 'none';
  if (numbers.length > 1) return 'conflict';
  return numbers[0] >= 1 && numbers[0] <= 12 ? numbers[0] : 'conflict';
}

// The age every transcript that states one agrees on; null (ask the LLM)
// when none states one, they disagree, one names two, or it is out of range.
export function matchAge(texts: string[]): number | null {
  return agree(texts.map((t) => ageReading(t, true)));
}

// The birth month every transcript that states one agrees on — a month name
// wins over a number in the same transcript ("8 मार्च" → 3); null otherwise.
export function matchMonth(texts: string[]): number | null {
  return agree(texts.map((t) => monthReading(t, true)));
}

// Post-processing of the LLM's reply: the same readers without the
// ambiguous-word rule (a bare "one" from the model is an answer).
export function readAge(text: string): number | null {
  return agree([ageReading(text, false)]);
}

export function readMonth(text: string): number | null {
  return agree([monthReading(text, false)]);
}
