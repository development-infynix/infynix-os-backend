import { Can } from '@nestjs/authorization';
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { CurrentActor } from '../tenancy/actor.resolver.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { CrmAssignmentService } from './crm-assignment.service.js';
import { CrmPolicy } from './crm.policy.js';
import {
  AccessListDto,
  AssignmentRuleDto,
  DealOwnerDto,
  DistributeDto,
  TransferDto,
  UnassignDto,
} from './dto/crm-assignment.dto.js';

/**
 * Deal assignment: /api/v1/crm (docs/user-deals-assignment.md). Reading needs
 * `use`; every change needs `manage` (Owner and managers, until permissions
 * come from System settings).
 */
@Controller('crm')
export class CrmAssignmentController {
  constructor(private readonly assignment: CrmAssignmentService) {}

  @Get('pipelines/:id/assignment')
  @Can(CrmPolicy, 'use')
  overview(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignment.overview(actor, id);
  }

  @Put('pipelines/:id/assignment-rule')
  @Can(CrmPolicy, 'manage')
  setRule(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignmentRuleDto) {
    return this.assignment.setRule(actor, id, dto);
  }

  @Post('pipelines/:id/assignments/share')
  @Can(CrmPolicy, 'manage')
  distribute(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DistributeDto) {
    return this.assignment.distribute(actor, id, dto);
  }

  @Post('pipelines/:id/assignments/unassign')
  @Can(CrmPolicy, 'manage')
  unassign(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UnassignDto) {
    return this.assignment.unassign(actor, id, dto);
  }

  @Post('pipelines/:id/assignments/transfer')
  @Can(CrmPolicy, 'manage')
  transfer(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TransferDto) {
    return this.assignment.transfer(actor, id, dto);
  }

  @Get('pipelines/:id/users')
  @Can(CrmPolicy, 'manage')
  accessList(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.assignment.accessList(actor, id);
  }

  @Put('pipelines/:id/users')
  @Can(CrmPolicy, 'manage')
  saveAccessList(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AccessListDto) {
    return this.assignment.saveAccessList(actor, id, dto);
  }

  @Patch('deals/:id/owner')
  @Can(CrmPolicy, 'manage')
  setDealOwner(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DealOwnerDto) {
    return this.assignment.setDealOwner(actor, id, dto.ownerId ?? null);
  }
}
