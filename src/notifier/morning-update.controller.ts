import {
  BadRequestException,
  Body,
  Controller,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { MediaMetaDataService } from '../media-meta-data/media-meta-data.service';
import { UserService } from '../users/user.service';
import { triggerMorningUpdateForUser } from './morning-update.processor';

export class TriggerMorningUpdateDto {
  @IsString()
  @IsOptional()
  user_id?: string;

  @IsString()
  @IsOptional()
  user_external_id?: string;
}

export interface TriggerMorningUpdateResponse {
  job_id: string;
  user_id: string;
  user_external_id: string;
}

@ApiTags('morning-update')
@Controller('morning-update')
export class MorningUpdateController {
  constructor(
    private readonly userService: UserService,
    private readonly mediaMetaDataService: MediaMetaDataService,
  ) {}

  @Post('send')
  @ApiOperation({
    summary: 'Trigger a morning-update send for a single user',
    description:
      'Enqueues one morning-update-send job. Provide exactly one of ' +
      'user_id (uuid) or user_external_id (E.164 phone, no leading +). ' +
      'Returns 202-style {job_id} once queued; actual WhatsApp delivery ' +
      'happens asynchronously and may be delayed if the per-user report ' +
      'card is still rendering.',
  })
  async send(
    @Body() body: TriggerMorningUpdateDto,
  ): Promise<TriggerMorningUpdateResponse> {
    const id = body.user_id ?? body.user_external_id;
    if (!id || (body.user_id && body.user_external_id)) {
      throw new BadRequestException(
        'Provide exactly one of user_id or user_external_id',
      );
    }
    return triggerMorningUpdateForUser(
      id,
      this.userService,
      this.mediaMetaDataService,
    );
  }
}
