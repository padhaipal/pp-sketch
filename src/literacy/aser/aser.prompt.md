# ASER (Hindi) test proxy — aser.ts / aser.service.ts (2026-10)

A WhatsApp adaptation of the Hindi ASER reading test, delivered INSIDE the
normal lesson loop so every item also teaches. Hindi only. No dashboards
yet. **No ASER-specific stids**: every item uses the lesson loop's own, and
correctness is inferred from the next stid, as in a normal lesson.

## Four tests

| Test | Item | Pass rule |
|---|---|---|
| l1 letter | ONE lesson walking the bank letters through the letter loop (`aserLetters` machine input) | 4 right before 7 wrong |
| l2 word | one bank word per lesson (normal word lesson, letter drill on a miss) | 4 right before 7 wrong |
| l3 paragraph | a LIFTeracy level-9 passage (read + drill + comprehension) | either of two passages read right |
| l4 story | one LIFTeracy level-10 passage | read right |

An item's outcome is its FIRST answer. Everything after it (drills, retry
read, comprehension) runs as usual — teaching, letter scores, NIPUN/MPL-B
comprehension pools. Each run records right/wrong counts for every test it
reached, decided or not (everything wrong at onboarding = l2 0–2 undecided,
l1 0–7 failed). Reads at levels 9 and 10 allow a flat three errors
(sentence-assessment `FLAT_READ_ERROR_BUDGET`) — every level-9/10 read.

### Letter test in the letter loop

`wrongLetters` = the bank letters not yet answered (shuffled). Each letter's
first answer is counted in `context.aserLetters` (letter state; letterNoImage
first try). Stids are the loop's own: right → `${next}-letter-routeWrongLetter-correct-more`,
wrong → `${letter}-letter-image-wrong` and the usual image/letterImage drill
→ `${next}-…-more`. When 4 right / 7 wrong decide it, the queue is cut to
the current letter, so the loop leaves through its normal `…-last` return to
`word` — on the next ASER word when letters pass with words undecided (that
word becomes the word item: "correct, now read X"), otherwise on a spare
bank word (practice only; the test is over). `aserLetters.done` stops
counting, so a drill inside that word is ordinary.

## Routing (`recordAserAnswer`)

Onboarding runs start at words. Retests start at the ASER level of the
student's pre-test lesson level (`aserStartStage`: ≤ 8 → word, 9 →
paragraph, 10+ → story). The fast jump (first two words both right →
paragraph, both wrong → letters) applies only to a run that STARTED at
words. Once decided: passed → up only (stop at a level already failed /
after the story); failed → down only (stop at a level already passed /
after letters). Paragraph: first passage right → story; wrong → second;
both wrong → down. Story: pass ends the test; fail drops to paragraph if
undecided (only on a retest that started at story).

## Banks (`chooseBank`)

Five banks of 10 words + 10 letters (no bank letter occurs in its own
words). A run's bank is random among those not yet SHOWN in the current
cycle, worked out from the past runs' own state (`bank`, and `used` letters
/ words on each run's latest row) — nothing else is stored. The cycle
restarts after all five were shown; a run that never reached letters/words
used none up; at a cycle start the last bank shown is skipped.

## Passage word exclusion

Paragraphs exclude words drilled at the word level (answered wrong); the
story also excludes this run's paragraph drill words. This run only. Exact
token match (`splitLessonWords`). Never-assigned passages first. If every
candidate has an excluded word the exclusion is dropped (warn); with no
passage at the level the run ends with what is known.

## Schedule (`AserService.dueTest`)

Milestone 0 = the first lesson ever (right after onboarding); then after
2 h, 5 h, 10 h, 15 h, … of all-time active time (users/active-time.ts, per
IST day). One run per milestone reached (students already past several get
one now). Never once any nightly `mpl_b_passed` is true or a run passed
the story.

## State and persistence

`AserState` rides in each ASER lesson row's `snapshot.context.aser`;
LiteracyLessonService applies `applyAserTurn` on each voice turn. An
abandoned item is delivered again (an abandoned letter test restarts on the
letters not yet answered). ASER rows have `level = NULL` and are excluded
from progression, so a retest returns the student to their pre-test level.
The onboarding run's placement (`ASER_PLACEMENT_LEVEL`: beginner 1 → floor 2,
letter 2, word 3, paragraph 9, story 10) selects the next lesson.

## Results — the NIPUN/MPL-B pattern

- `computeAserTestScores` / `aserTestScoresFromRows` (`ASER_ROWS_SQL`): per
  test, `AserTestScore` { status, runs_available, latest, history } — each
  finished run that reached the test: correct, incorrect, passed (null =
  undecided), `at` = the answer that ended the run. Unfinished runs wait.
- `GET /users/:id/literacy-test-scores` → `aser_l1` … `aser_l4`.
- Nightly (test-results.service.ts, migration
  1794000000000-AddAserMetrics): `test_results_student.aser_lN_correct /
  _incorrect / _passed / _at` (latest); `test_results_geo_entity.aser_lN_n
  / _pass / _fail`, summed up the tree. No age band. No backfill.
