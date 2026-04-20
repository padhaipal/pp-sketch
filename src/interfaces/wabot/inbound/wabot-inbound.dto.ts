import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { OtelCarrierDto } from '../../../otel/otel.dto';

@ValidatorConstraint({ name: 'typeMatchesPayload', async: false })
class TypeMatchesPayloadConstraint implements ValidatorConstraintInterface {
  validate(_: unknown, args: ValidationArguments): boolean {
    const dto = args.object as MessageDto;

    const typeToField: Record<string, unknown> = {
      audio: dto.audio,
      text: dto.text,
      video: dto.video,
      system: dto.system,
    };

    const presentFields = Object.entries(typeToField).filter(
      ([, value]) => value !== undefined,
    );

    return presentFields.length === 1 && presentFields[0][0] === dto.type;
  }

  defaultMessage(args: ValidationArguments): string {
    const dto = args.object as MessageDto;
    return `type "${dto.type}" must match the populated field. Exactly one of audio, text, video or system must be present and it must match type.`;
  }
}

export class AudioDto {
  @IsString()
  url!: string;
}

export class VideoDto {
  @IsString()
  url!: string;
}

export class TextDto {
  @IsString()
  body!: string;
}

export class SystemDto {
  @IsString()
  body!: string;

  @IsString()
  wa_id!: string;
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
  @ValidateNested()
  @Type(() => TextDto)
  text?: TextDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => VideoDto)
  video?: VideoDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SystemDto)
  system?: SystemDto;

  @Validate(TypeMatchesPayloadConstraint)
  private readonly typeMatchesPayload!: true;
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
