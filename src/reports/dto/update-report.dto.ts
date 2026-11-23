import { IsIn } from 'class-validator';
import { ReportContentDto } from './create-report.dto.js';

/** A full replacement of a report's content; `keep` leaves its link or file as it is. */
export class UpdateReportDto extends ReportContentDto {
  @IsIn(['keep', 'none', 'url', 'file'])
  attachmentMode!: 'keep' | 'none' | 'url' | 'file';
}
