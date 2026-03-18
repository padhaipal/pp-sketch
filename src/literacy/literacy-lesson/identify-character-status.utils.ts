import { LogMethod } from 'src/common/decorators/log-method.decorator';

export type Word = string & { readonly __brand: unique symbol };
const toWord = (s: string): Word => s as Word;

const clean = (str: string): string =>
  str
    .normalize('NFC')
    .trim()
    .replace(/[^\p{L}\p{M}]/gu, '')
    .toLocaleLowerCase();

type EditOperation =
  | { type: 'equal'; from: number; to: number; aChar: string; bChar: string }
  | { type: 'insert'; from: number; to: number; aChar: ''; bChar: string }
  | { type: 'delete'; from: number; to: number; aChar: string; bChar: '' }
  | { type: 'replace'; from: number; to: number; aChar: string; bChar: string };

type Cell = { cost: number; matchCount: number };

const better = (a: Cell, b: Cell): Cell =>
  b.cost < a.cost || (b.cost === a.cost && b.matchCount > a.matchCount) ? b : a;

function buildMatrix({
  source,
  target,
}: {
  source: Word;
  target: Word;
}): Cell[][] {
  const rows = target.length + 1;
  const cols = source.length + 1;

  const m: Cell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ cost: 0, matchCount: 0 })),
  );

  for (let i = 1; i < rows; i++) m[i][0].cost = i;
  for (let j = 1; j < cols; j++) m[0][j].cost = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      if (target[i - 1] === source[j - 1]) {
        const d = m[i - 1][j - 1];
        m[i][j] = { cost: d.cost, matchCount: d.matchCount + 1 };
        continue;
      }
      const del = { ...m[i][j - 1], cost: m[i][j - 1].cost + 1 };
      const ins = { ...m[i - 1][j], cost: m[i - 1][j].cost + 1 };
      const sub = { ...m[i - 1][j - 1], cost: m[i - 1][j - 1].cost + 1 };
      m[i][j] = [del, ins, sub].reduce(better);
    }
  }
  return m;
}

const charsEqual = (i: number, j: number, src: Word, tgt: Word) =>
  i > 0 && j > 0 && tgt[i - 1] === src[j - 1];

type Candidate = {
  type: 'insert' | 'delete' | 'replace';
  cell: Cell;
  nextI: number;
  nextJ: number;
};

const buildCandidates = (i: number, j: number, m: Cell[][]): Candidate[] => {
  const c: Candidate[] = [];
  if (i > 0 && j > 0)
    c.push({
      type: 'replace',
      cell: m[i - 1][j - 1],
      nextI: i - 1,
      nextJ: j - 1,
    });
  if (j > 0)
    c.push({ type: 'delete', cell: m[i][j - 1], nextI: i, nextJ: j - 1 });
  if (i > 0)
    c.push({ type: 'insert', cell: m[i - 1][j], nextI: i - 1, nextJ: j });
  return c;
};

const pickBestCand = (c: Candidate[]): Candidate =>
  c.reduce((best, cur) =>
    better(best.cell, cur.cell) === cur.cell ? cur : best,
  );

interface EmitArgs {
  ops: EditOperation[];
  cand: Candidate;
  pos: { i: number; j: number };
  src: Word;
  tgt: Word;
}

const emit = ({ ops, cand, pos: { i, j }, src, tgt }: EmitArgs): void => {
  if (cand.type === 'replace') {
    ops.unshift({
      type: 'replace',
      from: j - 1,
      to: i - 1,
      aChar: src[j - 1],
      bChar: tgt[i - 1],
    });
    return;
  }
  if (cand.type === 'delete') {
    ops.unshift({
      type: 'delete',
      from: j - 1,
      to: i,
      aChar: src[j - 1],
      bChar: '',
    });
    return;
  }
  ops.unshift({
    type: 'insert',
    from: j,
    to: i - 1,
    aChar: '',
    bChar: tgt[i - 1],
  });
};

const traceBack = ({
  source,
  target,
  matrix,
}: {
  source: Word;
  target: Word;
  matrix: Cell[][];
}): EditOperation[] => {
  const ops: EditOperation[] = [];
  let i = target.length;
  let j = source.length;

  while (i > 0 || j > 0) {
    if (charsEqual(i, j, source, target)) {
      ops.unshift({
        type: 'equal',
        from: j - 1,
        to: i - 1,
        aChar: source[j - 1],
        bChar: target[i - 1],
      });
      i--;
      j--;
      continue;
    }
    const cand = pickBestCand(buildCandidates(i, j, matrix));
    emit({ ops, cand, pos: { i, j }, src: source, tgt: target });
    i = cand.nextI;
    j = cand.nextJ;
  }
  return ops;
};

const levenshteinWithOps = ({
  source,
  target,
}: {
  source: Word;
  target: Word;
}) => {
  const matrix = buildMatrix({ source, target });
  const operations = traceBack({ source, target, matrix });
  return { distance: matrix[target.length][source.length].cost, operations };
};

export interface CharacterStatus {
  correctChars: string[];
  incorrectChars: string[];
}

interface IdentifyArgs {
  correctAnswer: string;
  studentAnswer: string;
}

class IdentifyCharacterStatus {
  @LogMethod()
  static identify({
    correctAnswer,
    studentAnswer,
  }: IdentifyArgs): CharacterStatus {
    const studentWords = studentAnswer
      .trim()
      .split(/\s+/)
      .map((w) => toWord(clean(w)));

    const correctWord = toWord(clean(correctAnswer));

    const allCorrectChars = new Set(correctWord);

    let bestCorrectSet = new Set<string>();
    let bestDist = Infinity;
    let bestMatches = -1;

    for (const studentWord of studentWords) {
      const { distance, operations } = levenshteinWithOps({
        source: studentWord,
        target: correctWord,
      });

      const matches = operations.filter((o) => o.type === 'equal').length;
      const betterCandidate =
        distance < bestDist || (distance === bestDist && matches > bestMatches);

      if (betterCandidate) {
        bestDist = distance;
        bestMatches = matches;

        const mismatched = new Set(
          operations.filter((o) => o.type !== 'equal').map((o) => o.bChar).filter(Boolean),
        );
        bestCorrectSet = new Set(
          [...allCorrectChars].filter((c) => !mismatched.has(c)),
        );
      }
    }

    return {
      correctChars: [...allCorrectChars].filter((c) => bestCorrectSet.has(c)),
      incorrectChars: [...allCorrectChars].filter((c) => !bestCorrectSet.has(c)),
    };
  }
}

export const identifyCharacterStatus = (args: IdentifyArgs) =>
  IdentifyCharacterStatus.identify(args);
