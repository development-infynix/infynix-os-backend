import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, Matches, Max, Min, ValidateIf } from 'class-validator';

export class UpdateReportSettingsDto {
  @ValidateIf((dto: UpdateReportSettingsDto) => dto.dueTime !== null)
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'Due time must use the HH:MM format.' })
  dueTime!: string | null;

  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  skipDays!: number[];
}
