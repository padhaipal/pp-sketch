# test-results.controller.ts — POST /admin/test-results/run?full=

Manual trigger with the same shape as POST /admin/mirror: enqueues a job via
`TestResultsService.enqueue(full)` and returns 202 `{ status: 'enqueued',
full }`; 409 while a run is live. `full` is true for `true` / `1`. No
pp-sketch-side auth: reachable only through the pp-dashboard proxy, whose
admin allowlist excludes `admin/*`, so the dev role only.
