import {
  IsDefined,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';

function IsStringRecord(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isStringRecord',
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

          return Object.values(value).every(
            (entry) => typeof entry === 'string',
          );
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be an object with string values`;
        },
      },
    });
  };
}

export class OtelCarrierDto {
  @IsDefined()
  @IsStringRecord()
  carrier!: Record<string, string>;
}
