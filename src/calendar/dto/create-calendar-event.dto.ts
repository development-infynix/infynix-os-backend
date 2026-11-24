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
import { CALENDAR_EVENT_TYPES, TASK_PRIORITIES } from '../../db/schema.js';

/** 62 days: the longest an announcement or a meeting may run. */
export const MAX_DURATION_MINUTES = 62 * 24 * 60;

/** One DTO for every type; the service checks which fields each type needs and rejects the rest. */
export class CreateCalendarEventDto {
  @IsIn(CALENDAR_EVENT_TYPES)
  type!: (typeof CALENDAR_EVENT_TYPES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  /** Announcement / meeting: when it starts. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'startsAt must be a date and time.' })
  startsAt?: string;

  /** Announcement / meeting: how long it lasts. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_MINUTES)
  durationMinutes?: number;

  /** Task: when it's due. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'deadline must be a date and time.' })
  deadline?: string;

  /** Task: who does it. */
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  /** Task: low, medium (default), high or urgent. */
  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: (typeof TASK_PRIORITIES)[number];

  /** Meeting: a room, an address or a link. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  /** Meeting: open (everyone) or private (creator and members). */
  @IsOptional()
  @IsIn(['open', 'private'])
  visibility?: 'open' | 'private';

  /** Meeting: people to invite (the creator is always included). */
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  memberIds?: string[];
}
