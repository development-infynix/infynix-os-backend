import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const trimLower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreatePipelineDto {
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name: string;

  /** The wizard's stages in board order. Defaults to a standard Sales board. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(30)
  @IsString({ each: true })
  @Length(1, 80, { each: true })
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((stage) => (typeof stage === 'string' ? stage.trim() : stage))
      : value,
  )
  stages?: string[];

  /**
   * Pipeline access: people with the CRM menu grant who may see and work in
   * this pipeline. Owners are never listed (they see every pipeline).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds?: string[];
}

export class UpdatePipelineDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;
}

export class CreateStageDto {
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name: string;
}

export class UpdateStageDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 80)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;
}

/** All of a pipeline's stage ids, in their new left-to-right order. */
export class ReorderStagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID(undefined, { each: true })
  stageIds: string[];
}

/**
 * Creates a deal in a pipeline. Either point at an existing client, or send
 * the add-client form's fields and the service creates the client first —
 * both in one transaction.
 */
export class CreateDealDto {
  @IsUUID()
  pipelineId: string;

  /** Defaults to the pipeline's first stage. */
  @IsOptional()
  @IsUUID()
  stageId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @Transform(trimLower)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(50)
  phone?: string;

  @IsOptional()
  @IsObject()
  customDetails?: Record<string, unknown>;
}

export class MoveDealDto {
  @IsUUID()
  stageId: string;

  /** Defaults to the end of the target stage. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;
}

/** ?pipelineId=...&q=acme&limit=20: search by client name, email or phone. */
export class ListDealsQuery {
  @IsUUID()
  pipelineId: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

/** ?limit=100: cards loaded per column on the board. */
export class BoardQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 100;
}

/** ?offset=100&limit=100: the next cards of one board column, in board order. */
export class StageDealsQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit: number = 100;
}

/** Bulk add from the Clients page: up to 100 existing clients per request. */
export class AddDealsDto {
  @IsUUID()
  pipelineId: string;

  /** Where the deals land; defaults to the pipeline's first stage. */
  @IsOptional()
  @IsUUID()
  stageId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  clientIds: string[];
}
