// pp-sketch/src/wabot/inbound/wabot-inbound.dto.prompt.md

import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { OtelCarrierDto } from '../../otel/otel.dto';

@ValidatorConstraint({ name: 'exactlyOneOfAudioTextVideoSystem', async: false })
class ExactlyOneOfAudioTextVideoSystemConstraint
  implements ValidatorConstraintInterface
{
  validate(_: unknown, args: ValidationArguments): boolean {
    const dto = args.object as MessageDto;

    const presentCount = [dto.audio, dto.text, dto.video, dto.system].filter(
      (value) => value !== undefined,
    ).length;

    return presentCount === 1;
  }

  defaultMessage(): string {
    return 'Exactly one of audio, text, video or system must be present.';
  }
}

export class AudioDto {
  @IsString()
  mediaUrl!: string;
}

export class VideoDto {
  @IsString()
  mediaUrl!: string;
}

export class MessageDto {
  @IsString()
  from!: string;

  @IsString()
  id!: string;

  @IsString()
  timestamp!: string;

  @IsString()
  type!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AudioDto)
  audio?: AudioDto;

  @IsOptional()
  @IsObject()
  text?: Record<string, unknown>;

  @IsOptional()
  @ValidateNested()
  @Type(() => VideoDto)
  video?: VideoDto;

  @IsOptional()
  @IsObject()
  system?: Record<string, unknown>;

  @Validate(ExactlyOneOfAudioTextVideoSystemConstraint)
  private readonly exactlyOneOfAudioTextVideoSystem!: true;
}

export class MessageJobDto {
  @ValidateNested()
  @Type(() => OtelCarrierDto)
  otel!: OtelCarrierDto;

  @ValidateNested()
  @Type(() => MessageDto)
  message!: MessageDto;

  @IsOptional()
  @IsBoolean()
  consecutive?: boolean;
}