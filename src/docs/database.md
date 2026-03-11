The pg database has a railway deployed redis cache service called pp-redis-cache.
The pg database is a railway deployed service called pp-db.
The S3 bucket is a railway deployed service called media-bucket.

Database fallback
* If redis is down then log a WARN and connect to the PG database directly.
* If the PG database is down then log a WARN.