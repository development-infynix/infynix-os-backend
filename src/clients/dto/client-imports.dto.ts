import { Transform } from 'class-transformer';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** First step of an import: register the file and its expected row count. */
export class ImportNameDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name: string;
}

export class CreateClientImportDto extends ImportNameDto {

  @Transform(trim)
  @IsString()
  @Length(1, 255)
  fileName: string;

  @IsInt()
  @Min(1)
  @Max(500)
  rowCount: number;
}
