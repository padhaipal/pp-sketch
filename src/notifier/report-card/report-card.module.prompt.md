// pp-sketch/src/notifier/report-card/report-card.module.prompt.md

Provides ReportCardService and the swagger preview controller.

Imports:
* TypeOrmModule.forFeature([MediaMetaDataEntity]) — for findExistingForUser.
* UserModule — for UserService and UserActivityService.
* ScoreModule — for ScoreService.getLettersLearnt({ asOf }).
* MediaMetaDataModule — for MediaMetaDataService.createRenderedImageMedia.

Exports ReportCardService so the morning-update send worker (resolved in
src/main.ts via app.get) can render the card before sending.