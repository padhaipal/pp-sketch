# backfill-block-coords.ts / .main.ts — block label points

Blocks are the only level with neither a polygon nor a register coordinate;
the dashboard renders each block as a label at `geo_entity.lat/lng`, which
this pass fills with the geometric median (geometric-median.ts) of the
block's schools that have non-null lat/lng. Blocks with no located school
keep null and render no label.

`backfillBlockCoords(deps)` (pure over injected I/O): districts in code
order; per district — one query for `(block_id, lat, lng)` of located
schools, one for the district's block ids — then ONE transaction per
district writing `GeoEntityService.updateBlockCoordinates(id, lat, lng)`
(`UPDATE geo_entity b SET lat=$2, lng=$3, updated_at=now() WHERE b.id=$1 AND
b.type='block'`). Logs every 100 districts and a summary
`{districts, blocksLocated, blocksUnlocated}`.

Called from two places: `seed-geo-entities.ts` as its final step (a register
refresh that adds blocks locates them in the same run), and the standalone
CLI `node dist/scripts/backfill-block-coords.main.js` for databases seeded
before the seed had this step — runbook in src/docs/seeding-geo-entities.md.

Re-seed protection: `GeoEntityService.upsertBatch` COALESCEs `lat`/`lng` for
`type = 'block'` rows only, so a seed run carrying null block coordinates
never wipes these.
