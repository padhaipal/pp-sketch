// Defensive — must never throw, so the workflow step that pipes us into
// $GITHUB_STEP_SUMMARY always succeeds even when the artillery report is
// malformed or partially written.

const fs = require('fs');

let report;
try {
  report = JSON.parse(fs.readFileSync('./report.json', 'utf8'));
} catch (err) {
  process.stdout.write(
    '## Load test\n\nReport unavailable: ' + err.message + '\n',
  );
  process.exit(0);
}

const aggregate = report.aggregate ?? {};
const summaries = aggregate.summaries ?? {};
const latency = summaries['http.response_time'] ?? {};
const counters = aggregate.counters ?? {};

const sumByPrefix = (prefix) =>
  Object.entries(counters)
    .filter(([k]) => k.startsWith(prefix))
    .reduce((acc, [, v]) => acc + v, 0);

const fmt = (v) => (typeof v === 'number' ? v : 'n/a');

const rows = [
  ['p50 (ms)', fmt(latency.p50)],
  ['p95 (ms)', fmt(latency.p95)],
  ['p99 (ms)', fmt(latency.p99)],
  ['mean (ms)', fmt(latency.mean)],
  ['requests', counters['http.requests'] ?? 0],
  ['2xx', sumByPrefix('http.codes.2')],
  ['4xx', sumByPrefix('http.codes.4')],
  ['5xx', sumByPrefix('http.codes.5')],
  ['errors', sumByPrefix('errors.')],
];

const lines = ['## Load test', '', '| metric | value |', '|---|---|'];
for (const [k, v] of rows) lines.push('| ' + k + ' | ' + v + ' |');
process.stdout.write(lines.join('\n') + '\n');
