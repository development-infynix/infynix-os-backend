import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { assertContact, normalizeContact } from '../clients/clients.service.js';
import { ClientsRepository, type Client } from '../clients/clients.repository.js';
import { isUniqueViolation } from '../db/errors.js';
import { TenantDb, type TenantTx } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import {
  type CrmDealCard,
  type CrmEligibleUser,
  type CrmPipeline,
  type CrmStage,
  CrmRepository,
} from './crm.repository.js';
import type {
  AddDealsDto,
  CreateDealDto,
  CreatePipelineDto,
  CreateStageDto,
  MoveDealDto,
  UpdatePipelineDto,
  UpdateStageDto,
} from './dto/crm.dto.js';

const DEFAULT_PIPELINE_NAME = 'Sales';

/** The board a company gets the first time it opens the CRM. */
const DEFAULT_STAGES = [
  'Lead In',
  'Qualified',
  'Proposal',
  'Negotiation',
  'Won',
  'Lost',
];

const PIPELINE_NAME_IN_USE = 'A pipeline with that name already exists';
const STAGE_NAME_IN_USE = 'A stage with that name already exists in this pipeline';
const CLIENT_ALREADY_IN_PIPELINE = 'This client is already in this pipeline';
const NOT_ELIGIBLE = 'Only people with CRM access can be added to a pipeline';

export interface StageResponse {
  id: string;
  name: string;
  position: number;
}

export interface PipelineResponse {
  id: string;
  name: string;
  position: number;
  stages: StageResponse[];
}

const toStageResponse = (stage: CrmStage): StageResponse => ({
  id: stage.id,
  name: stage.name,
  position: stage.position,
});

const toPipelineResponse = (
  pipeline: CrmPipeline,
  stages: CrmStage[],
): PipelineResponse => ({
  id: pipeline.id,
  name: pipeline.name,
  position: pipeline.position,
  stages: stages.map(toStageResponse),
});

/**
 * CRM: pipelines, stages and deals inside the actor's own company (all
 * through TenantDb). A deal is one client's participation in one pipeline:
 * the "CRM id" points at the client, which stays the source of truth for
 * name, email, phone and custom details.
 */
@Injectable()
export class CrmService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly crm: CrmRepository,
    private readonly clients: ClientsRepository,
  ) {}

  /* ── Pipelines ────────────────────────────────────────────────────────── */

  /**
   * The pipelines this person may see, with their stages. Seeds the default
   * Sales board the first time the company opens the CRM: decided on the
   * company's pipelines, not this person's, so someone on no pipeline never
   * causes a second Sales board.
   */
  async listPipelines(actor: Actor): Promise<PipelineResponse[]> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const userId = this.memberId(actor);
      // One query in the usual case. Only an empty answer needs the count: the
      // company may have none yet (seed the default board), or this person may
      // just not be on any (don't seed a second one).
      const pipelines = await this.crm.pipelineSummaries(tx, userId);
      if (pipelines.length || (await this.crm.countPipelines(tx)) > 0) return pipelines;
      await this.seedDefaultPipeline(tx, actor.tenant.id);
      return this.crm.pipelineSummaries(tx, userId);
    });
  }

  async createPipeline(
    actor: Actor,
    dto: CreatePipelineDto,
  ): Promise<PipelineResponse> {
    const names = this.stageNames(dto.stages);
    const userIds = [...new Set(dto.userIds ?? [])];
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        if (userIds.length) {
          const eligible = new Set(
            (await this.crm.listCrmEligibleUsers(tx)).map((user) => user.id),
          );
          if (userIds.some((id) => !eligible.has(id))) {
            throw new BadRequestException(NOT_ELIGIBLE);
          }
        }
        const position = await this.crm.nextPipelinePosition(tx);
        const pipeline = await this.crm.createPipeline(tx, {
          tenantId: actor.tenant.id,
          name: dto.name,
          position,
        });
        await this.crm.addPipelineUsers(
          tx,
          userIds.map((userId) => ({
            tenantId: actor.tenant.id,
            pipelineId: pipeline.id,
            userId,
            grantedBy: actor.user.id,
          })),
        );
        const stages = await this.crm.createStages(
          tx,
          names.map((name, index) => ({
            tenantId: actor.tenant.id,
            pipelineId: pipeline.id,
            name,
            position: index,
          })),
        );
        return toPipelineResponse(pipeline, stages);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(PIPELINE_NAME_IN_USE);
      throw error;
    }
  }

  /** People who can be given access to a pipeline (step 3 of the wizard). */
  eligibleUsers(actor: Actor): Promise<CrmEligibleUser[]> {
    return this.tenantDb.run(actor.tenant.id, (tx) => this.crm.listCrmEligibleUsers(tx));
  }

  async updatePipeline(
    actor: Actor,
    id: string,
    dto: UpdatePipelineDto,
  ): Promise<PipelineResponse> {
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        const pipeline = await this.findPipelineOrFail(tx, actor, id);
        const updated =
          dto.name === undefined && dto.position === undefined
            ? pipeline
            : ((await this.crm.updatePipeline(tx, id, dto)) ?? pipeline);
        const stages = await this.crm.findPipelineStages(tx, id);
        return toPipelineResponse(updated, stages);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(PIPELINE_NAME_IN_USE);
      throw error;
    }
  }

  /** What the delete confirmation shows: stages and deals that will go. */
  getDeleteImpact(actor: Actor, id: string) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.findPipelineOrFail(tx, actor, id);
      const [dealCount, stageCount] = await Promise.all([
        this.crm.countDealsInPipeline(tx, id),
        this.crm.countStagesInPipeline(tx, id),
      ]);
      return { dealCount, stageCount };
    });
  }

  /**
   * Deletes the pipeline with its deals, stages and access list.
   * Clients are never touched. Deals go first because their FKs are RESTRICT.
   */
  async deletePipeline(actor: Actor, id: string): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.findPipelineOrFail(tx, actor, id);
      await this.crm.removeDealsForPipeline(tx, id);
      await this.crm.removePipeline(tx, id);
    });
  }

  /* ── Stages ───────────────────────────────────────────────────────────── */

  async createStage(
    actor: Actor,
    pipelineId: string,
    dto: CreateStageDto,
  ): Promise<StageResponse> {
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        await this.findPipelineOrFail(tx, actor, pipelineId);
        const position = await this.crm.nextStagePosition(tx, pipelineId);
        const stage = await this.crm.createStage(tx, {
          tenantId: actor.tenant.id,
          pipelineId,
          name: dto.name,
          position,
        });
        return toStageResponse(stage);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(STAGE_NAME_IN_USE);
      throw error;
    }
  }

  async updateStage(
    actor: Actor,
    id: string,
    dto: UpdateStageDto,
  ): Promise<StageResponse> {
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        const stage = await this.findStageOrFail(tx, actor, id);
        const updated =
          dto.name === undefined && dto.position === undefined
            ? stage
            : ((await this.crm.updateStage(tx, id, dto)) ?? stage);
        return toStageResponse(updated);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(STAGE_NAME_IN_USE);
      throw error;
    }
  }

  /** Replaces the left-to-right order; `stageIds` must list every stage once. */
  async reorderStages(
    actor: Actor,
    pipelineId: string,
    stageIds: string[],
  ): Promise<StageResponse[]> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.findPipelineOrFail(tx, actor, pipelineId);
      const stages = await this.crm.findPipelineStages(tx, pipelineId);
      const current = new Set(stages.map((stage) => stage.id));
      if (
        stageIds.length !== stages.length ||
        new Set(stageIds).size !== stageIds.length ||
        stageIds.some((id) => !current.has(id))
      ) {
        throw new BadRequestException(
          'Provide every stage of the pipeline exactly once',
        );
      }
      const updated: CrmStage[] = [];
      for (const [position, id] of stageIds.entries()) {
        const stage = await this.crm.updateStage(tx, id, { position });
        if (stage) updated.push(stage);
      }
      return updated
        .sort((a, b) => a.position - b.position)
        .map(toStageResponse);
    });
  }

  async deleteStage(actor: Actor, id: string): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.findStageOrFail(tx, actor, id);
      const deals = await this.crm.countDealsInStage(tx, id);
      if (deals > 0) {
        throw new ConflictException(
          'Move or delete this stage’s deals before deleting it',
        );
      }
      await this.crm.removeStage(tx, id);
    });
  }

  /* ── Deals and board ──────────────────────────────────────────────────── */

  /**
   * The board: stages in order, the newest cards of each (up to `limit`) and
   * each stage's true total.
   */
  async board(actor: Actor, pipelineId: string, limit: number) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const pipeline = await this.findPipelineOrFail(tx, actor, pipelineId);
      const { stages, columns, totals } = await this.crm.boardColumns(tx, pipelineId, limit);
      return {
        pipeline: toPipelineResponse(pipeline, stages),
        stages: stages.map(toStageResponse),
        columns,
        totals,
      };
    });
  }

  /**
   * A slice of one column in board order, with the column's current total.
   * Offsets drift if someone else moves cards meanwhile; the board drops
   * duplicates, and its next refetch fills any gap.
   */
  async stageDeals(actor: Actor, stageId: string, offset: number, limit: number) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.findStageOrFail(tx, actor, stageId);
      const [items, total] = await Promise.all([
        this.crm.dealCardsForStage(tx, stageId, limit, offset),
        this.crm.countDealsInStage(tx, stageId),
      ]);
      return { items, total };
    });
  }

  async getDeal(actor: Actor, id: string): Promise<CrmDealCard> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const card = await this.crm.dealCard(tx, id);
      if (!card || !(await this.canSee(tx, actor, card.pipelineId))) {
        throw new NotFoundException('Deal not found');
      }
      return card;
    });
  }

  /** Search the current pipeline by client name, email or phone. */
  async searchDeals(actor: Actor, pipelineId: string, q: string, limit: number) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.findPipelineOrFail(tx, actor, pipelineId);
      const term = q.trim();
      if (!term) return { items: [] };
      return { items: await this.crm.searchDeals(tx, pipelineId, term, limit) };
    });
  }

  /**
   * Creates the CRM record for the pipeline. With `clientId` it attaches an
   * existing client; otherwise it creates the client from the add-client form
   * in the same transaction, so a failure leaves neither behind.
   */
  async createDeal(actor: Actor, dto: CreateDealDto): Promise<CrmDealCard> {
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        const pipeline = await this.findPipelineOrFail(tx, actor, dto.pipelineId);
        const stages = await this.crm.findPipelineStages(tx, pipeline.id);
        const stage = dto.stageId
          ? stages.find((item) => item.id === dto.stageId)
          : stages[0];
        if (!stage) {
          throw new BadRequestException('Stage does not belong to this pipeline');
        }

        const client = await this.resolveClient(tx, actor, dto);
        const existing = await this.crm.findDealByClient(
          tx,
          pipeline.id,
          client.id,
        );
        if (existing) throw new ConflictException(CLIENT_ALREADY_IN_PIPELINE);

        const position = await this.crm.nextDealPosition(tx, stage.id);
        const deal = await this.crm.createDeal(tx, {
          tenantId: actor.tenant.id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          clientId: client.id,
          position,
          createdBy: actor.user.id,
        });
        const card = await this.crm.dealCard(tx, deal.id);
        if (!card) throw new ConflictException('Unable to create the deal');
        return card;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(CLIENT_ALREADY_IN_PIPELINE);
      }
      throw error;
    }
  }

  /**
   * Bulk add from the Clients page: existing clients become deals at the end
   * of one stage (the first by default), in a single insert. Clients already
   * in the pipeline, and ids that aren't clients of this company, are skipped
   * and counted rather than failing the batch.
   */
  async addDeals(actor: Actor, dto: AddDealsDto) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const pipeline = await this.findPipelineOrFail(tx, actor, dto.pipelineId);
      const stages = await this.crm.findPipelineStages(tx, pipeline.id);
      const stage = dto.stageId ? stages.find((item) => item.id === dto.stageId) : stages[0];
      if (!stage) throw new BadRequestException('Stage does not belong to this pipeline');

      const requested = [...new Set(dto.clientIds)];
      const found = new Set((await this.clients.findByIds(tx, requested)).map((client) => client.id));
      const existing = await this.crm.clientIdsWithDealIn(tx, pipeline.id, [...found]);
      const toAdd = requested.filter((id) => found.has(id) && !existing.has(id));

      const start = await this.crm.nextDealPosition(tx, stage.id);
      const added = await this.crm.createDeals(
        tx,
        toAdd.map((clientId, index) => ({
          tenantId: actor.tenant.id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          clientId,
          position: start + index,
          createdBy: actor.user.id,
        })),
      );
      return {
        added,
        // Includes any that got a deal between the check and the insert.
        alreadyInPipeline: existing.size + (toAdd.length - added),
        notFound: requested.length - found.size,
      };
    });
  }

  /** Moves a deal to another stage of its own pipeline (position defaults to the end). */
  async moveDeal(
    actor: Actor,
    id: string,
    dto: MoveDealDto,
  ): Promise<CrmDealCard> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const found = await this.crm.findDeal(tx, id);
      if (!found || !(await this.canSee(tx, actor, found.pipelineId))) {
        throw new NotFoundException('Deal not found');
      }
      // Moves in one pipeline queue up here. Without the lock, two quick moves
      // in the same stage both read the old order and the second one writes
      // over the first. Re-read the deal once we hold it: a move that ran
      // while we waited may have changed its stage, or deleted it.
      await this.crm.lockPipeline(tx, found.pipelineId);
      const deal = await this.crm.findDeal(tx, id);
      if (!deal) throw new NotFoundException('Deal not found');
      const stage = await this.crm.findStage(tx, dto.stageId);
      if (!stage || stage.pipelineId !== deal.pipelineId) {
        throw new BadRequestException('Stage does not belong to this pipeline');
      }
      const sourceStageId = deal.stageId;
      // Re-index both stages so positions stay unique and match the board,
      // instead of leaving several cards on the same position.
      const targetIds = (
        await this.crm.dealIdsInStage(tx, stage.id)
      ).filter((dealId) => dealId !== id);
      const index = Math.min(
        Math.max(dto.position ?? targetIds.length, 0),
        targetIds.length,
      );
      targetIds.splice(index, 0, id);
      await this.crm.placeDeals(tx, stage.id, targetIds);
      if (sourceStageId !== stage.id) {
        const sourceIds = await this.crm.dealIdsInStage(tx, sourceStageId);
        await this.crm.placeDeals(tx, sourceStageId, sourceIds);
      }
      const card = await this.crm.dealCard(tx, id);
      if (!card) throw new NotFoundException('Deal not found');
      return card;
    });
  }

  /** Removes the deal from the pipeline; the client stays in the directory. */
  async deleteDeal(actor: Actor, id: string): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const deal = await this.crm.findDeal(tx, id);
      if (!deal || !(await this.canSee(tx, actor, deal.pipelineId))) {
        throw new NotFoundException('Deal not found');
      }
      await this.crm.removeDeal(tx, id);
    });
  }

  /* ── Helpers ──────────────────────────────────────────────────────────── */

  private async resolveClient(
    tx: TenantTx,
    actor: Actor,
    dto: CreateDealDto,
  ): Promise<Client> {
    if (dto.clientId) {
      const client = await this.clients.find(tx, dto.clientId);
      if (!client) throw new NotFoundException('Client not found');
      return client;
    }

    if (!dto.name) {
      throw new BadRequestException('Provide a client or a client name');
    }
    const email = normalizeContact(dto.email);
    const phone = normalizeContact(dto.phone);
    assertContact(email, phone);
    return this.clients.create(tx, {
      tenantId: actor.tenant.id,
      name: dto.name,
      email,
      phone,
      customDetails: { ...dto.customDetails },
    });
  }

  private async seedDefaultPipeline(
    tx: TenantTx,
    tenantId: string,
  ): Promise<void> {
    const pipeline = await this.crm.createPipelineIfAbsent(tx, {
      tenantId,
      name: DEFAULT_PIPELINE_NAME,
      position: 0,
    });
    if (!pipeline) return;
    await this.crm.createStages(
      tx,
      DEFAULT_STAGES.map((name, position) => ({
        tenantId,
        pipelineId: pipeline.id,
        name,
        position,
      })),
    );
    // Same rule as the access backfill: everyone who can use the CRM today.
    const eligible = await this.crm.listCrmEligibleUsers(tx);
    await this.crm.addPipelineUsers(
      tx,
      eligible.map((user) => ({
        tenantId,
        pipelineId: pipeline.id,
        userId: user.id,
        grantedBy: null,
      })),
    );
  }

  private stageNames(input?: string[]): string[] {
    const names = (input ?? DEFAULT_STAGES).map((name) => name.trim());
    if (names.some((name) => !name)) {
      throw new BadRequestException('Stage names cannot be blank');
    }
    const seen = new Set<string>();
    for (const name of names) {
      const key = name.toLocaleLowerCase();
      if (seen.has(key)) {
        throw new BadRequestException(`Duplicate stage name: "${name}"`);
      }
      seen.add(key);
    }
    return names;
  }

  /** Null for owners (they see every pipeline), otherwise the person's own id. */
  private memberId(actor: Actor): string | null {
    return actor.user.role === 'owner' ? null : actor.user.id;
  }

  /** Pipeline access: owners always; everyone else needs a membership row. */
  private async canSee(tx: TenantTx, actor: Actor, pipelineId: string): Promise<boolean> {
    const userId = this.memberId(actor);
    return userId === null || this.crm.isPipelineMember(tx, pipelineId, userId);
  }

  /**
   * The pipeline, if this person may see it. A pipeline they have no access
   * to is reported as not found, so its existence doesn't leak.
   */
  private async findPipelineOrFail(
    tx: TenantTx,
    actor: Actor,
    id: string,
  ): Promise<CrmPipeline> {
    const pipeline = await this.crm.findPipeline(tx, id);
    if (!pipeline || !(await this.canSee(tx, actor, pipeline.id))) {
      throw new NotFoundException('Pipeline not found');
    }
    return pipeline;
  }

  /** The stage, if this person may see its pipeline. */
  private async findStageOrFail(tx: TenantTx, actor: Actor, id: string): Promise<CrmStage> {
    const stage = await this.crm.findStage(tx, id);
    if (!stage || !(await this.canSee(tx, actor, stage.pipelineId))) {
      throw new NotFoundException('Stage not found');
    }
    return stage;
  }
}
