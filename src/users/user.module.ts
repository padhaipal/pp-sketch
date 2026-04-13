import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { UserService } from './user.service';
import { CacheService } from '../interfaces/redis/cache';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity])],
  providers: [UserService, CacheService],
  exports: [UserService],
})
export class UserModule {}
