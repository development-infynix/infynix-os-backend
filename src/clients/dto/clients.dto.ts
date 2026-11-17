import { Transform, Type } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  type ValidationArguments,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const hasContact = (dto: { email?: string; phone?: string }) =>
  [dto.email, dto.phone].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );

/**
 * A client needs a way to reach them. Registered on the class against a
 * synthetic property so `@IsOptional()` on email and phone cannot skip it.
 */
function HasContact(): ClassDecorator {
  return (target) =>
    registerDecorator({
      name: 'hasContact',
      target,
      propertyName: 'contact',
      validator: {
        validate: (_value: unknown, args: ValidationArguments) =>
          hasContact(args.object as { email?: string; phone?: string }),
        defaultMessage: () => 'Provide an email or a phone number',
      },
    });
}

@HasContact()
export class CreateClientDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name: string;

  @IsOptional()
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsObject()
  customDetails?: Record<string, unknown>;
}

/** On update the service checks the merged email/phone, not just the patch. */
export class UpdateClientDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsObject()
  customDetails?: Record<string, unknown>;
}

/** ?page=1&pageSize=100&q=acme: one page of the company's clients. */
export class ListClientsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 100;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;
}
