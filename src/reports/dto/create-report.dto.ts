import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

/** Fields shared by a new report and an edit. Points are trimmed and checked again in the service. */
export abstract class ReportContentDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'Report date must use the YYYY-MM-DD format.',
  })
  reportDate!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Add at least one work.' })
  @ArrayMaxSize(100, { message: 'A report can have at most 100 works.' })
  @IsString({ each: true })
  reports!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2048, { message: 'The link must be at most 2048 characters.' })
  attachmentUrl?: string;
}

export class CreateReportDto extends ReportContentDto {
  @IsIn(['none', 'url'])
  attachmentMode!: 'none' | 'url';
}
