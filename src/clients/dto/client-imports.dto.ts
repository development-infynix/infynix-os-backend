import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';

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

/** ?q=acme&page=1&pageSize=20&withClients=true: one page of imports, newest first. */
export class SearchImportsQuery {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  q?: string;

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
  pageSize: number = 20;

  /** Only imports that still have clients (the Clients page selection menu). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  withClients: boolean = false;
}

/** One DELETE batch, driven by the UI so it can show progress. */
export class DeleteImportChunkQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}
