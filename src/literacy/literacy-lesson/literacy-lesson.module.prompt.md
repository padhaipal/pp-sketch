Standard NestJS module.
* Imports `TypeOrmModule.forFeature([LiteracyLessonStateEntity])` to register the lesson state repository.
* Imports ScoreModule (LiteracyLessonService depends on ScoreService for word selection via selectNextWord).
* Provides and exports LiteracyLessonService so it can be injected by the wabot inbound processor and other modules.
* LiteracyLessonService owns the `literacy_lesson_states` table (reads and writes lesson state).
* The XState machine (literacy-lesson.machine.ts) is imported directly by LiteracyLessonService — it is a pure function, not a NestJS provider.
