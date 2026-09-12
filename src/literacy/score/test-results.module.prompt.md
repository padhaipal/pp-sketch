# test-results.module.ts

Registers the three entities (also listed in
src/interfaces/database/data-source.ts), provides `TestResultsService`,
mounts `TestResultsController`, imports GeoEntityModule (ancestor walks).
Imported by AppModule; main.ts resolves the service for the worker.
