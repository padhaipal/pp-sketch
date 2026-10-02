import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  TestResultStudentEntity,
  TestResultGeoEntityEntity,
  TestRunEntity,
} from './test-results.entity';
import { TestResultsService } from './test-results.service';
import { TestResultsController } from './test-results.controller';
import { DashboardScoresService } from './dashboard-scores.service';
import { DashboardScoresController } from './dashboard-scores.controller';
import { GeoEntityModule } from '../../geo-entities/geo-entity.module';
import { PiiAccessModule } from '../../users/pii-access.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TestResultStudentEntity,
      TestResultGeoEntityEntity,
      TestRunEntity,
    ]),
    GeoEntityModule,
    PiiAccessModule,
  ],
  controllers: [TestResultsController, DashboardScoresController],
  providers: [TestResultsService, DashboardScoresService],
  exports: [TestResultsService, DashboardScoresService],
})
export class TestResultsModule {}
