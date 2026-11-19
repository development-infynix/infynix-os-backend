import { Can } from '@nestjs/authorization';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { CurrentActor } from '../tenancy/actor.resolver.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { CrmPolicy } from './crm.policy.js';
import { CrmService } from './crm.service.js';
import {
  AddDealsDto,
  BoardQuery,
  CreateDealDto,
  CreatePipelineDto,
  CreateStageDto,
  ListDealsQuery,
  MoveDealDto,
  ReorderStagesDto,
  UpdatePipelineDto,
  UpdateStageDto,
} from './dto/crm.dto.js';

/**
 * CRM: /api/v1/crm. Routes that shape the board need the `manage` grant
 * (owner or manager); working inside a pipeline only needs `use`.
 */
@Controller('crm')
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  /* ── Pipelines ────────────────────────────────────────────────────────── */

  @Get('pipelines')
  @Can(CrmPolicy, 'use')
  listPipelines(@CurrentActor() actor: Actor) {
    return this.crm.listPipelines(actor);
  }

  /** People who can be given pipeline access: step 3 of the create-pipeline wizard. */
  @Get('pipelines/eligible-users')
  @Can(CrmPolicy, 'manage')
  eligibleUsers(@CurrentActor() actor: Actor) {
    return this.crm.eligibleUsers(actor);
  }

  @Post('pipelines')
  @Can(CrmPolicy, 'manage')
  createPipeline(@CurrentActor() actor: Actor, @Body() dto: CreatePipelineDto) {
    return this.crm.createPipeline(actor, dto);
  }

  @Get('pipelines/:id/delete-impact')
  @Can(CrmPolicy, 'manage')
  getDeleteImpact(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.crm.getDeleteImpact(actor, id);
  }

  @Get('pipelines/:id/board')
  @Can(CrmPolicy, 'use')
  board(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BoardQuery,
  ) {
    return this.crm.board(actor, id, query.limit);
  }

  @Patch('pipelines/:id')
  @Can(CrmPolicy, 'manage')
  updatePipeline(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePipelineDto,
  ) {
    return this.crm.updatePipeline(actor, id, dto);
  }

  @Delete('pipelines/:id')
  @HttpCode(204)
  @Can(CrmPolicy, 'manage')
  async deletePipeline(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.crm.deletePipeline(actor, id);
  }

  /* ── Stages ───────────────────────────────────────────────────────────── */

  @Post('pipelines/:id/stages')
  @Can(CrmPolicy, 'manage')
  createStage(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateStageDto,
  ) {
    return this.crm.createStage(actor, id, dto);
  }

  @Put('pipelines/:id/stages/order')
  @Can(CrmPolicy, 'manage')
  reorderStages(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderStagesDto,
  ) {
    return this.crm.reorderStages(actor, id, dto.stageIds);
  }

  @Patch('stages/:id')
  @Can(CrmPolicy, 'manage')
  updateStage(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStageDto,
  ) {
    return this.crm.updateStage(actor, id, dto);
  }

  @Delete('stages/:id')
  @HttpCode(204)
  @Can(CrmPolicy, 'manage')
  async deleteStage(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.crm.deleteStage(actor, id);
  }

  /* ── Deals ────────────────────────────────────────────────────────────── */

  /** Search the pipeline by client name, email or phone. */
  @Get('deals')
  @Can(CrmPolicy, 'use')
  searchDeals(@CurrentActor() actor: Actor, @Query() query: ListDealsQuery) {
    return this.crm.searchDeals(actor, query.pipelineId, query.q ?? '', query.limit);
  }

  /** Bulk add existing clients (up to 100 per request) to one stage of a pipeline. */
  @Post('deals/bulk')
  @Can(CrmPolicy, 'use')
  addDeals(@CurrentActor() actor: Actor, @Body() dto: AddDealsDto) {
    return this.crm.addDeals(actor, dto);
  }

  @Get('deals/:id')
  @Can(CrmPolicy, 'use')
  getDeal(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.crm.getDeal(actor, id);
  }

  /**
   * Adds a deal to the pipeline: either an existing client by `clientId`, or
   * the add-client form's fields, which creates the client and the deal
   * together. `stageId` defaults to the first stage of the current pipeline.
   */
  @Post('deals')
  @Can(CrmPolicy, 'use')
  createDeal(@CurrentActor() actor: Actor, @Body() dto: CreateDealDto) {
    return this.crm.createDeal(actor, dto);
  }

  @Patch('deals/:id')
  @Can(CrmPolicy, 'use')
  moveDeal(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MoveDealDto,
  ) {
    return this.crm.moveDeal(actor, id, dto);
  }

  @Delete('deals/:id')
  @HttpCode(204)
  @Can(CrmPolicy, 'use')
  async deleteDeal(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.crm.deleteDeal(actor, id);
  }
}
