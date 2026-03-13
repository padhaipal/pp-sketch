Standard NestJS module.
* Provides and exports ScoreService so other modules can inject it.
* `score.service.ts` also exports a module-level `scoreService` instance (the same singleton the DI container holds) for direct import by non-DI consumers (e.g. `literacy-lesson.machine.ts`).
