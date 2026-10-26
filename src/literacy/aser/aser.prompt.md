# ASER (Hindi) test proxy — aser.ts / aser.service.ts (2026-10)

A WhatsApp adaptation of the Hindi ASER reading test, delivered INSIDE the
normal lesson loop so every item also teaches. Hindi only (the English ASER
differs and is not implemented). No dashboards yet.

## Levels and items

| ASER level | Item | Pass rule |
|---|---|---|
| letter | one bank letter; the lesson is the word loop's letter subroutine alone (`letterOnly` machine input) | 4 right before 7 wrong |
| word | one bank word; the normal word lesson (letter drill on a miss) | 4 right before 7 wrong |
| paragraph | a LIFTeracy level-9 passage (normal read + drill + comprehension) | either of two passages read right |
| story | one LIFTeracy level-10 passage | read right |

An item's outcome is its FIRST answer (`answerCorrect === true` on the
lesson's first voice turn: word `…-word-complete-correct-first`, letter
right first time, passage read passed first time). The rest of the lesson
(drills, retry read, comprehension question) runs as usual — teaching,
letter scores and NIPUN/MPL-B comprehension pools are all updated normally.
Reads at levels 9 and 10 allow a flat three errors (sentence-assessment
`FLAT_READ_ERROR_BUDGET`) — for every level-9/10 read, ASER or not; nothing
else about their grading changed.

Items are drawn at random from one of five banks (A–E, `ASER_BANKS`), rotated
by run (run 6 reuses A). No bank letter occurs in its own bank's words.

## Routing (`recordAserAnswer`)

Start at words. First two words both right → paragraph; both wrong →
letters; mixed → stay. Counts carry across visits (the fast jump fires only
at exactly two word answers). Once a level is decided: passed → move up
only (stop at a level already failed / after the story); failed → move down
only (stop at a level already passed / after letters). Paragraph: first
passage right → story; wrong → second passage; both wrong → down to words if
undecided, else done. Story: either way the test ends.

Result = highest level passed (`beginner` if none; passing implies the
levels below). Timestamp = the row whose answer ended the test
(`completed_at` in `aserRunsFromRows`).

## Passage word exclusion

Paragraph passages must not contain a word drilled at the word level (=
answered wrong — a word answered right got feedback but no drill and stays
allowed). The story additionally excludes the drill words chosen during
this run's paragraph reads (`…-sentence-word-drillWord`). Only this run;
other runs and normal lessons never exclude. Exact token match after
`splitLessonWords`. Candidates: ready level-exact passages not used in the
run, never-assigned ones first, random. If every candidate contains an
excluded word the exclusion is dropped (warn) rather than ending the test;
with no passage at the level at all the run ends with what is known.

## Schedule (`AserService.dueTest`)

Checked at every fresh lesson start that is not mid-test. Milestone 0 = the
student's first lesson ever (right after onboarding); then the lesson after
all-time active time reaches 2 h, 5 h, 10 h, 15 h, … (`aserMilestoneForHours`;
active time = users/active-time.ts rule summed per IST day, as the nightly
usage metric / backfill-usage). One run per milestone reached (a student
already past several gets one run for the highest). Never again once any
nightly `test_results_student.mpl_b_passed` is true (a failed MPL-B grade
does not stop it) or a run passed the story level. Existing students never
get a milestone-0 run (they have lessons already).

## State and persistence

`AserState` rides in every ASER lesson row's `snapshot.context.aser`; the
machine never reads or changes it. LiteracyLessonService applies
`applyAserTurn` on each voice turn (first answer → `recordAserAnswer`;
paragraph drill words) and persists it. Abandoned item (no answer, lesson
went stale) → delivered again at the next start (resume). ASER rows are
written with `level = NULL` and are excluded from progression
(`snapshot->'context'->>'aser' IS NULL` in recent_rows / lifetime_done_count;
prev_level already skips NULL), so a retest hands the student back their
pre-test level. The onboarding run sets `placementLevel`
(`ASER_PLACEMENT_LEVEL`: beginner 1, letter 2, word 3, paragraph 9, story 10;
1 is floored to 2, the lowest lesson level); the lesson after it is selected
at that level (`selectNextString(forcedLevel)`), and a placed student skips
the new-user level-2 floor while their own history is short.

## Stids (unseeded = nothing is sent)

- `aser-test-start` before the first item, `aser-test-complete` on the turn
  that ends the test.
- Letter items open on `${letter}-word-routeWrongLetter-drillLetters` (the
  letter drill's existing per-letter prompt) and end on
  `aser-letter-complete-correct|incorrect` (replacing the drill → word
  returns, which would prompt for a word).

## Results

`GET /users/:id/literacy-test-scores` → `aser`: one `AserRunResult` per run
(`aserRunsFromRows` over `ASER_ROWS_SQL`). The nightly test-results job does
not store ASER yet.
