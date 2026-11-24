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
import { TASK_PRIORITIES } from '../../db/schema.js';
import { TASK_ACTIONS } from '../task-workflow.js';
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
  /**
   * Announcement / meeting: `cancel` or `restore`. Task: a workflow step from
   * `task-workflow.ts` (start, submit, approve, hold…); each step takes only
   * the fields its rule lists.
   */
  @IsOptional()
  @IsIn([...new Set(['cancel', 'restore', ...TASK_ACTIONS])])
  action?: string;

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

  /* ---- Task fields: editing (creator / owner) ---- */

  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'deadline must be a date and time.' })
  deadline?: string;

  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @IsOptional()
  @IsIn(TASK_PRIORITIES)
  priority?: (typeof TASK_PRIORITIES)[number];

  /* ---- Task fields: workflow steps ---- */

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  holdReason?: string;

  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'holdUntil must be a date and time.' })
  holdUntil?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  cancelReason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  completionRemarks?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  @IsOptional()
  @IsISO8601({ strict: true }, { message: 'extensionUntil must be a date and time.' })
  extensionUntil?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  extensionReason?: string;
}
