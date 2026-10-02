import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ScoreService } from './score.service';
import { LetterBinsResult, LetterBinsQueryDto } from './score.dto';
import { PiiAccessService } from '../../users/pii-access.service';
import { maskPii } from '../../users/pii-mask';
import {
  ANONYMOUS,
  assertUuidUnlessStaff,
  Viewer,
  type ViewerContext,
} from '../../auth/viewer';

@ApiTags('scores')
@Controller('scores')
export class ScoreController {
  constructor(
    private readonly scoreService: ScoreService,
    private readonly piiAccess: PiiAccessService,
  ) {}

  // Learnt / improved / regressed letter bins per student. Staff may name
  // students by phone; a /d link holder must use uuids (no phone → id
  // oracle) and only sees the phone of students directly below them.
  @Get('letter-bins')
  async letterBins(
    @Query() query: LetterBinsQueryDto,
    @Viewer() viewer: ViewerContext = ANONYMOUS,
  ): Promise<LetterBinsResult[]> {
    for (const id of query.users) assertUuidUnlessStaff(viewer, id);
    const results = (await this.scoreService.getLetterBins(
      query.users,
    )) as LetterBinsResult[];
    const visible = await this.piiAccess.visibleTo(
      viewer,
      results.map((r) => r.userId),
    );
    return results.map((r) =>
      visible.has(r.userId) ? r : { ...r, userPhone: maskPii(r.userPhone) },
    );
  }
}
