import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { MAX_DURATION_MINUTES } from './create-calendar-event.dto.js';

/**
 * An edit (`{ version, ...fields }`) or a step: `{ version, action: 'cancel', reason? }`
 * or `{ version, action: 'restore' }`.
 * `version` is the one the client read; a stale one is a 409.
 */
export class UpdateCalendarEventDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  /** `cancel` an upcoming event, or `restore` a cancelled one whose start hasn't come. */
  @IsIn(['cancel', 'restore'])
  action?: 'cancel' | 'restore';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'startsAt must be a date and time.' })
  startsAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_MINUTES)
  durationMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @IsOptional()
  @IsIn(['open', 'private'])
  visibility?: 'open' | 'private';

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  memberIds?: string[];
}
