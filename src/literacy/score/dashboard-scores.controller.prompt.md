# dashboard-scores.controller.ts — public GET /geo-entities/:id/{scores,scores.csv,spotlight}

Unauthenticated, forwardable reads for /d/:id (the pp-dashboard proxy's
PUBLIC_ALLOWED list carries exactly these). `metric` required (nipun_g2 |
nipun_g3 | mpl_b), `range` 30 | 90 (default 30), `:id` a uuid; 400 otherwise.
All three set `Cache-Control: public, max-age=300` — the data changes once a
night and these are the heaviest queries in the app. `scores.csv` returns
the children rows as `text/csv` with a `Content-Disposition` filename of
`lifteracy-<type>-<code>-<metric>-<range>d.csv`.

Known limitation (deliberate, pilot stage): any geo entity id is accepted,
so a link holder can walk country → … → school and read student rows
nationally. Mitigations: student labels carry no phone digits, the page is
noindex, responses are cached. Follow-up: a per-user HMAC token in the link
scoping reads to the holder's subtree.
