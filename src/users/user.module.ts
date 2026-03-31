import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { CacheService } from '../interfaces/redis/cache';

@Module({
  providers: [UserService, CacheService],
  exports: [UserService],
})
export class UserModule {}
