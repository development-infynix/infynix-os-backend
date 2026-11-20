import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsUUID,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CRM_ASSIGNMENT_RULES, type CrmAssignmentRule } from '../../db/schema.js';

const DISTRIBUTE_METHODS = ['round_robin', 'single_user'] as const;

/** The pipeline's rule for new deals; `singleUserId` only with `single_user`. */
export class AssignmentRuleDto {
  @IsIn(CRM_ASSIGNMENT_RULES)
  rule: CrmAssignmentRule;

  @ValidateIf((dto: AssignmentRuleDto) => dto.rule === 'single_user')
  @IsUUID()
  singleUserId?: string;
}

/** Share (round robin) or Give (single user) the oldest unassigned deals. */
export class DistributeDto {
  @IsIn(DISTRIBUTE_METHODS)
  method: (typeof DISTRIBUTE_METHODS)[number];

  @ValidateIf((dto: DistributeDto) => dto.method === 'single_user')
  @IsUUID()
  userId?: string;
}

/** Unassign one person's deals and/or deals of one source (at least one of the two). */
export class UnassignDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsIn(CRM_ASSIGNMENT_RULES)
  source?: CrmAssignmentRule;
}

/** Move one person's deals (optionally of one source) to someone else. */
export class TransferDto {
  @IsUUID()
  fromUserId: string;

  @IsUUID()
  toUserId: string;

  @IsOptional()
  @IsIn(CRM_ASSIGNMENT_RULES)
  source?: CrmAssignmentRule;
}

/** What happens to deals owned by people removed from the list. */
export class HandoverDto {
  @IsIn(['unassign', 'transfer'])
  mode: 'unassign' | 'transfer';

  @ValidateIf((dto: HandoverDto) => dto.mode === 'transfer')
  @IsUUID()
  toUserId?: string;
}

/** The whole access list, replacing the current one. */
export class AccessListDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  userIds: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => HandoverDto)
  handover?: HandoverDto;
}

/** A hand-picked owner for one deal, or null to unassign it. */
export class DealOwnerDto {
  @ValidateIf((dto: DealOwnerDto) => dto.ownerId !== null)
  @IsUUID()
  ownerId: string | null;
}
