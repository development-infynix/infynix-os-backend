import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsOptional, IsUUID } from 'class-validator';

/** One chunk of deals to delete (the board's Select › Delete). */
export class DeleteDealsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  dealIds: string[];
}

/**
 * One transfer chunk: `move` re-points the deals; `copy` (Add to another
 * pipeline) leaves them and creates new deals in the target.
 */
export class TransferDealsDto {
  @IsIn(['move', 'copy'])
  mode: 'move' | 'copy';

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  dealIds: string[];

  @IsUUID()
  targetPipelineId: string;

  @IsOptional()
  @IsUUID()
  targetStageId?: string;
}

/** ?stageIds=a,b,c: the stages whose deals are being transferred. */
export class DealIdsQuery {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',').map((id) => id.trim()).filter(Boolean) : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  stageIds: string[];
}
