import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CrmAssignmentRule } from '../db/schema.js';
import { TenantDb, type TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import {
  ASSIGNMENT_CHUNK,
  CrmAssignmentRepository,
  type AccessCandidate,
  type AssignmentOverview,
} from './crm-assignment.repository.js';
import { CrmRepository, type CrmDealCard } from './crm.repository.js';
import type {
  AccessListDto,
  AssignmentRuleDto,
  DistributeDto,
  TransferDto,
  UnassignDto,
} from './dto/crm-assignment.dto.js';

const NOT_ELIGIBLE_OWNER =
  'That person can’t own deals in this pipeline: they must be on its access list, active, with CRM access, and not the Owner';

/**
 * Who owns each deal: the pipeline's rule for new deals, the bulk tools for
 * existing ones, the access list and hand-picked owners
 * (docs/user-deals-assignment.md). Every write takes one statement where it can.
 */
@Injectable()
export class CrmAssignmentService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly assignment: CrmAssignmentRepository,
    private readonly crm: CrmRepository,
  ) {}

  overview(actor: Actor, pipelineId: string): Promise<AssignmentOverview & { chunkSize: number }> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      return this.readOverview(tx, pipelineId);
    });
  }

  /** The rule for new deals only: existing owners never change (D1). */
  setRule(actor: Actor, pipelineId: string, dto: AssignmentRuleDto) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      const singleUserId = dto.rule === 'single_user' ? (dto.singleUserId ?? null) : null;
      if (dto.rule === 'single_user') {
        if (!singleUserId || !(await this.assignment.isEligibleOwner(tx, pipelineId, singleUserId))) {
          throw new BadRequestException(NOT_ELIGIBLE_OWNER);
        }
      }
      await this.assignment.setRule(tx, pipelineId, dto.rule, singleUserId);
      return this.readOverview(tx, pipelineId);
    });
  }

  /** Share (round robin) or Give (single user): one chunk of the oldest unassigned deals. */
  distribute(actor: Actor, pipelineId: string, dto: DistributeDto) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      const result = await this.assignment.distribute(tx, {
        pipelineId,
        method: dto.method,
        userId: dto.method === 'single_user' ? (dto.userId ?? null) : null,
        limit: ASSIGNMENT_CHUNK,
      });
      if (dto.method === 'single_user' && !result.targetOk) throw new BadRequestException(NOT_ELIGIBLE_OWNER);
      return { assigned: result.assigned, remaining: result.remaining, eligibleCount: result.eligibleCount };
    });
  }

  /** One chunk of one person's deals and/or one source's deals becomes unassigned. */
  unassign(actor: Actor, pipelineId: string, dto: UnassignDto) {
    if (!dto.userId && !dto.source) throw new BadRequestException('Choose a person or a kind of assignment');
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      const result = await this.assignment.reassign(tx, {
        pipelineId,
        from: dto.userId ?? null,
        source: dto.source ?? null,
        to: null,
        limit: ASSIGNMENT_CHUNK,
      });
      return { unassigned: result.changed, remaining: result.remaining };
    });
  }

  /** One chunk of one person's deals moves to someone else; sources and the rule stay as they are. */
  transfer(actor: Actor, pipelineId: string, dto: TransferDto) {
    if (dto.fromUserId === dto.toUserId) throw new BadRequestException('Choose someone else to transfer to');
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      if (!(await this.assignment.isEligibleOwner(tx, pipelineId, dto.toUserId))) {
        throw new BadRequestException(NOT_ELIGIBLE_OWNER);
      }
      const result = await this.assignment.reassign(tx, {
        pipelineId,
        from: dto.fromUserId,
        source: dto.source ?? null,
        to: dto.toUserId,
        limit: ASSIGNMENT_CHUNK,
      });
      return { transferred: result.changed, remaining: result.remaining };
    });
  }

  accessList(actor: Actor, pipelineId: string): Promise<AccessCandidate[]> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      return this.assignment.accessCandidates(tx, pipelineId);
    });
  }

  /**
   * Replaces the access list. People added must be able to use the CRM.
   * Anyone removed who owns deals needs a `handover` (unassign or transfer
   * to someone staying), or this answers 409 with how many deals each owns.
   * Order matters for the access-list foreign keys: add, hand over, remove.
   */
  saveAccessList(actor: Actor, pipelineId: string, dto: AccessListDto): Promise<AccessCandidate[]> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      const wanted = [...new Set(dto.userIds)];
      const current = new Set(await this.assignment.members(tx, pipelineId));
      const leaving = [...current].filter((id) => !wanted.includes(id));
      const joining = wanted.filter((id) => !current.has(id));

      const crmUsers = await this.assignment.crmUsersAmong(tx, joining);
      if (joining.some((id) => !crmUsers.has(id))) {
        throw new BadRequestException('Only people with CRM access can be added to a pipeline');
      }

      const owned = await this.assignment.dealsOwnedBy(tx, pipelineId, leaving);
      const handover = dto.handover;
      if (owned.length && !handover) {
        throw new ConflictException({
          message: 'Some people being removed own deals here: unassign them or transfer them to someone staying',
          owners: owned,
        });
      }
      const to = handover?.mode === 'transfer' ? (handover.toUserId ?? null) : null;
      if (handover?.mode === 'transfer') {
        const target = to ?? '';
        if (!wanted.includes(target) || !(await this.assignment.crmUsersAmong(tx, [target])).has(target)) {
          throw new BadRequestException('Transfer the deals to someone who stays on the pipeline and can use the CRM');
        }
      }

      await this.crm.addPipelineUsers(
        tx,
        joining.map((userId) => ({ tenantId: actor.tenant.id, pipelineId, userId, grantedBy: actor.user.id })),
      );
      await this.assignment.handOver(tx, pipelineId, leaving, to);
      await this.assignment.removeMembers(tx, pipelineId, leaving);
      return this.assignment.accessCandidates(tx, pipelineId);
    });
  }

  /** A hand-picked owner (source `manual`) or none, from the deal drawer. */
  setDealOwner(actor: Actor, dealId: string, ownerId: string | null): Promise<CrmDealCard> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const deal = await this.crm.findDeal(tx, dealId);
      if (!deal || !(await this.canSee(tx, actor, deal.pipelineId))) throw new NotFoundException('Deal not found');
      if (ownerId && !(await this.assignment.isEligibleOwner(tx, deal.pipelineId, ownerId))) {
        throw new BadRequestException(NOT_ELIGIBLE_OWNER);
      }
      await this.assignment.setDealOwner(tx, dealId, ownerId);
      const card = await this.crm.dealCard(tx, dealId);
      if (!card) throw new NotFoundException('Deal not found');
      return card;
    });
  }

  private async readOverview(tx: TenantTx, pipelineId: string) {
    const overview = await this.assignment.overview(tx, pipelineId);
    if (!overview) throw new NotFoundException('Pipeline not found');
    return { ...overview, chunkSize: ASSIGNMENT_CHUNK };
  }

  /** Owners see every pipeline; everyone else only those they're on (404 otherwise, so nothing leaks). */
  private async canSee(tx: TenantTx, actor: Actor, pipelineId: string): Promise<boolean> {
    if (actor.user.role === 'owner') return Boolean(await this.crm.findPipeline(tx, pipelineId));
    return this.crm.isPipelineMember(tx, pipelineId, actor.user.id);
  }

  private async assertCanSee(tx: TenantTx, actor: Actor, pipelineId: string): Promise<void> {
    if (!(await this.canSee(tx, actor, pipelineId))) throw new NotFoundException('Pipeline not found');
  }
}

export type { CrmAssignmentRule };
