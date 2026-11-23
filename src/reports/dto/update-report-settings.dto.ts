import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateReportSettingsDto {
  /** IANA zone, e.g. Asia/Kolkata. Checked against the runtime's zone list in the service. */
  @IsString()
  @MaxLength(64)
  timezone!: string;

  @ValidateIf((dto: UpdateReportSettingsDto) => dto.dueTime !== null)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'Due time must use the HH:MM format.',
  })
  dueTime!: string | null;

  /** 0 = Sunday … 6 = Saturday. */
  @IsArray()
  @ArrayMaxSize(6, { message: 'Leave at least one working day.' })
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  skipDays!: number[];
}
