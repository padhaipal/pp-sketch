import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  TestResultStudentEntity,
  TestResultGeoEntityEntity,
  TestRunEntity,
} from './test-results.entity';
import { TestResultsService } from './test-results.service';
import { TestResultsController } from './test-results.controller';
import { GeoEntityModule } from '../../geo-entities/geo-entity.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TestResultStudentEntity,
      TestResultGeoEntityEntity,
      TestRunEntity,
    ]),
    GeoEntityModule,
  ],
  controllers: [TestResultsController],
  providers: [TestResultsService],
  exports: [TestResultsService],
})
export class TestResultsModule {}
