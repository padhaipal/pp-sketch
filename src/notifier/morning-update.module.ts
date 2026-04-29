import { Module } from '@nestjs/common';
import { UserModule } from '../users/user.module';
import { MediaMetaDataModule } from '../media-meta-data/media-meta-data.module';
import { MorningUpdateController } from './morning-update.controller';

@Module({
  imports: [UserModule, MediaMetaDataModule],
  controllers: [MorningUpdateController],
})
export class MorningUpdateModule {}
