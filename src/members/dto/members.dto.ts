import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsStrongPassword } from '../../auth/password-policy.js';
import type { MemberRole } from '../../tenancy/tenancy.types.js';

/** The roles an owner can give: the owner role itself belongs to whoever signed up. */
export const EMPLOYEE_ROLES = ['manager', 'staff'] as const satisfies readonly MemberRole[];
type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AddMemberDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  fullName: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** The starting password the owner gives the employee. */
  @IsStrongPassword()
  password: string;

  @IsIn(EMPLOYEE_ROLES, { message: 'role must be manager or staff' })
  role: EmployeeRole;
}

export class UpdateMemberDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  fullName?: string;

  /** Their sign-in email. Must not belong to another account. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsIn(EMPLOYEE_ROLES, { message: 'role must be manager or staff' })
  role?: EmployeeRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetMemberPasswordDto {
  @IsStrongPassword()
  password: string;
}

/** The complete set of menus a person should have; empty means none. */
export class SetMemberAccessDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Length(1, 80, { each: true })
  accessKeys: string[];
}

/** ?page=1&pageSize=50: one page of the company's users, newest page last. */
export class ListMembersQuery {
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
  pageSize: number = 50;

  @IsOptional()
  @IsIn(['active', 'deactivated'])
  status?: 'active' | 'deactivated';

  /** `admin` covers both administrative roles: owner and manager. */
  @IsOptional()
  @IsIn(['staff', 'admin'])
  role?: 'staff' | 'admin';
}

/** ?q=priya&limit=20: users whose name or email contains q. */
export class SearchMembersQuery {
  @Transform(trim)
  @IsString()
  @Length(1, 100)
  q: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;
}
