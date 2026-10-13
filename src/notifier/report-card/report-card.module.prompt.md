// pp-sketch/src/notifier/report-card/report-card.module.prompt.md

Provides ReportCardService and the swagger preview controller.

Imports:
* TypeOrmModule.forFeature([MediaMetaDataEntity]) — for findExistingForUser.
* UserModule — for UserService and UserActivityService.
* MediaMetaDataModule — for MediaMetaDataService.createRenderedImageMedia.

The service reads lesson levels and letter scores with inline SQL on the
DataSource (2026-10); ScoreModule is no longer needed.

Exports ReportCardService so the morning-update send worker (resolved in
src/main.ts via app.get) can render the card before sending.
