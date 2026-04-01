import {
  IsDefined,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

export type OtelCarrier = Record<string, string>;

function IsNonEmptyStringRecord(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isNonEmptyStringRecord',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value)
          ) {
            return false;
          }

          const entries = Object.values(value);
          return (
            entries.length > 0 &&
            entries.every((entry) => typeof entry === 'string')
          );
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a non-empty object with string values`;
        },
      },
    });
  };
}

export class OtelCarrierDto {
  @IsDefined()
  @IsNonEmptyStringRecord()
  carrier!: OtelCarrier;
}
