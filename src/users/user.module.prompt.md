Standard NestJS module.
* Imports `TypeOrmModule.forFeature([UserEntity, MediaMetaDataEntity, ScoreEntity, LiteracyLessonStateEntity])`.
* Provides and exports `UserService` (CRUD + cache) and `UserActivityService`
  (voice-message activity-time analytics, see `user-activity.service.prompt.md`).
  Other modules (e.g. InboundModule, ReportCardModule) inject these.
