Standard NestJS module.
* Registers ScoreController (exposes `GET /scores/letters-learnt` for pp-dashboard).
* Provides and exports ScoreService so other modules (e.g. LiteracyLessonModule) can inject it.
