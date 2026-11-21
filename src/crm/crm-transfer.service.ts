import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { isUniqueViolation } from '../db/errors.js';
import { TenantDb, type TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { CrmTransferRepository } from './crm-transfer.repository.js';
import { CrmRepository } from './crm.repository.js';
import type { DeleteDealsDto, TransferDealsDto } from './dto/crm-transfer.dto.js';

/**
 * Deal transfer (docs/deal-transfer.md): moving deals, chosen by whole
 * stages, to another pipeline, or adding them to it as well.
 */
@Injectable()
export class CrmTransferService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly transfer: CrmTransferRepository,
    private readonly crm: CrmRepository,
  ) {}

  /** Every deal in the chosen stages, so a transfer covers more than the cards loaded on the board. */
  dealIds(actor: Actor, pipelineId: string, stageIds: string[]): Promise<{ ids: string[] }> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.assertCanSee(tx, actor, pipelineId);
      return { ids: await this.transfer.dealIdsByStages(tx, pipelineId, stageIds) };
    });
  }

  /**
   * One chunk of a Move or an Add. The deals must come from one pipeline other
   * than the target; both must be visible. Clients already in the target are
   * skipped and named. Owners follow the target's rule (only Round robin and
   * Single user assign).
   */
  async run(actor: Actor, dto: TransferDealsDto) {
    const dealIds = [...new Set(dto.dealIds)];
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        await this.assertCanSee(tx, actor, dto.targetPipelineId);
        const sources = await this.transfer.pipelinesOf(tx, dealIds);
        if (sources.length > 1) throw new BadRequestException('All deals must come from the same pipeline');
        const sourcePipelineId = sources[0];
        if (!sourcePipelineId) {
          // None of them exist any more (deleted meanwhile).
          return { mode: dto.mode, moved: 0, added: 0, unassigned: 0, missing: dealIds.length, skipped: [] };
        }
        if (sourcePipelineId === dto.targetPipelineId) {
          throw new BadRequestException(
            dto.mode === 'move'
              ? 'Deals can’t be moved to the pipeline they’re already in'
              : 'These deals are already in this pipeline',
          );
        }
        await this.assertCanSee(tx, actor, sourcePipelineId);

        await this.transfer.lockPipelines(tx, [sourcePipelineId, dto.targetPipelineId]);
        const where = {
          sourcePipelineId,
          targetPipelineId: dto.targetPipelineId,
          targetStageId: dto.targetStageId,
          dealIds,
        };
        const result =
          dto.mode === 'move'
            ? await this.transfer.move(tx, where)
            : await this.transfer.copy(tx, { ...where, tenantId: actor.tenant.id, createdBy: actor.user.id });
        if (!result.stageFound) {
          throw new BadRequestException(
            dto.targetStageId ? 'That stage doesn’t belong to the target pipeline' : 'The target pipeline has no stages',
          );
        }
        const done = 'moved' in result ? result.moved : result.added;
        return {
          mode: dto.mode,
          moved: dto.mode === 'move' ? done : 0,
          added: dto.mode === 'copy' ? done : 0,
          unassigned: result.unassigned,
          missing: dealIds.length - result.found,
          skipped: result.skipped,
        };
      });
    } catch (error) {
      // A client gained a deal in the target between our check and the write.
      if (isUniqueViolation(error)) {
        throw new ConflictException('A client in this batch was just added to the target pipeline. Try again.');
      }
      throw error;
    }
  }

  /** Owners see every pipeline; everyone else only those they're on (404 otherwise, so nothing leaks). */
  /**
   * One chunk of the board's Select › Delete. Deals that are gone already, or
   * in a pipeline the person can't see, are counted as missing, not errors.
   */
  deleteMany(actor: Actor, dto: DeleteDealsDto): Promise<{ deleted: number; missing: number }> {
    const dealIds = [...new Set(dto.dealIds)];
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const deleted = await this.transfer.deleteMany(tx, {
        dealIds,
        userId: actor.user.id,
        isOwner: actor.user.role === 'owner',
      });
      return { deleted, missing: dealIds.length - deleted };
    });
  }

  private async assertCanSee(tx: TenantTx, actor: Actor, pipelineId: string): Promise<void> {
    const visible =
      actor.user.role === 'owner'
        ? Boolean(await this.crm.findPipeline(tx, pipelineId))
        : await this.crm.isPipelineMember(tx, pipelineId, actor.user.id);
    if (!visible) throw new NotFoundException('Pipeline not found');
  }
}
