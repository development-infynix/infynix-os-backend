import { Can } from '@nestjs/authorization';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { CurrentActor } from '../tenancy/actor.resolver.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { CrmTransferService } from './crm-transfer.service.js';
import { CrmPolicy } from './crm.policy.js';
import { DealIdsQuery, DeleteDealsDto, TransferDealsDto } from './dto/crm-transfer.dto.js';

/**
 * Deal transfer: /api/v1/crm (docs/deal-transfer.md). Listing a stage's deal
 * ids needs `use`; transferring needs `manage` (Owner and managers, until
 * permissions come from System settings).
 */
@Controller('crm')
export class CrmTransferController {
  constructor(private readonly transfer: CrmTransferService) {}

  @Get('pipelines/:id/deal-ids')
  @Can(CrmPolicy, 'use')
  dealIds(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Query() query: DealIdsQuery) {
    return this.transfer.dealIds(actor, id, query.stageIds);
  }

  @Post('deals/transfer')
  @Can(CrmPolicy, 'manage')
  run(@CurrentActor() actor: Actor, @Body() dto: TransferDealsDto) {
    return this.transfer.run(actor, dto);
  }

  /** The board's Select › Delete: up to 500 deals per request; `use`, like deleting one deal. */
  @Post('deals/delete')
  @Can(CrmPolicy, 'use')
  deleteMany(@CurrentActor() actor: Actor, @Body() dto: DeleteDealsDto) {
    return this.transfer.deleteMany(actor, dto);
  }
}
