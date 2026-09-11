import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeoEntityEntity } from './geo-entity.entity';
import { GeoEntityService } from './geo-entity.service';
import { GeoEntityController } from './geo-entity.controller';

@Module({
  imports: [TypeOrmModule.forFeature([GeoEntityEntity])],
  controllers: [GeoEntityController],
  providers: [GeoEntityService],
  exports: [GeoEntityService],
})
export class GeoEntityModule {}
