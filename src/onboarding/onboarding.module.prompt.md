# onboarding.module.ts

Registers `OnboardingStateEntity` (also listed in
src/interfaces/database/data-source.ts) and provides `OnboardingService`.
Imports UserModule (UserService) and LiteracyLessonModule
(LiteracyLessonService); provides the five LLM provider services directly
(they are dependency-free @Injectables — MediaMetaDataModule does not export
them). Exports OnboardingService.

Wiring checklist (the registration miss CLAUDE.md warns about):

- AppModule imports OnboardingModule.
- src/main.ts calls `assertOnboardingEnv()` first thing in bootstrap, then
  `app.get(OnboardingService)` and passes it as the LAST argument of
  `processWabotInboundJob` in the wabot-inbound worker.
