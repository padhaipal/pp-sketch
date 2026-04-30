import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ReportCardService } from './report-card.service';

@ApiTags('report-card')
@Controller('report-card')
export class ReportCardController {
  constructor(private readonly reportCardService: ReportCardService) {}

  @Get(':userIdOrPhone')
  @ApiOperation({
    summary: 'Render the morning-update report card image for a user',
    description:
      'Generates the PNG report card on-the-fly. Accepts either the user UUID or external_id (phone in E.164 sans +). Returns image/png.',
  })
  @ApiProduces('image/png')
  async preview(
    @Param('userIdOrPhone') userIdOrPhone: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer } = await this.reportCardService.generatePng(userIdOrPhone);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  }
}
