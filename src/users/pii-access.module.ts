import { Module } from '@nestjs/common';
import { PiiAccessService } from './pii-access.service';

// Stand-alone so ScoreModule / MediaMetaDataModule / TestResultsModule can
// import it without opening a cycle through UserModule.
@Module({
  providers: [PiiAccessService],
  exports: [PiiAccessService],
})
export class PiiAccessModule {}
