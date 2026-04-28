import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaMetaDataEntity } from '../../media-meta-data/media-meta-data.entity';
import { UserModule } from '../../users/user.module';
import { ScoreModule } from '../../literacy/score/score.module';
import { MediaMetaDataModule } from '../../media-meta-data/media-meta-data.module';
import { ReportCardService } from './report-card.service';
import { ReportCardController } from './report-card.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([MediaMetaDataEntity]),
    UserModule,
    ScoreModule,
    MediaMetaDataModule,
  ],
  controllers: [ReportCardController],
  providers: [ReportCardService],
  exports: [ReportCardService],
})
export class ReportCardModule {}