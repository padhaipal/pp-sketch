import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { MediaMetaDataEntity } from '../media-meta-data/media-meta-data.entity';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { CacheService } from '../interfaces/redis/cache';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, MediaMetaDataEntity])],
  controllers: [UserController],
  providers: [UserService, CacheService],
  exports: [UserService],
})
export class UserModule {}
