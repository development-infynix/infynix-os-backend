import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { CurrentActor } from '../tenancy/actor.resolver.js';
import { TenantPolicy } from '../tenancy/tenant.policy.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import {
  AddMemberDto,
  ListMembersQuery,
  SearchMembersQuery,
  SetMemberAccessDto,
  SetMemberPasswordDto,
  UpdateMemberDto,
} from './dto/members.dto.js';
import { MembersService } from './members.service.js';

/** Admin › Users: the owner manages their company's people. /api/v1/members */
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @Can(TenantPolicy, 'administer')
  list(@CurrentActor() actor: Actor, @Query() query: ListMembersQuery) {
    return this.members.list(actor, query.page, query.pageSize);
  }

  /** Search by name or email. Declared before ':id' so "search" isn't read as an id. */
  @Get('search')
  @Can(TenantPolicy, 'administer')
  search(@CurrentActor() actor: Actor, @Query() query: SearchMembersQuery) {
    return this.members.search(actor, query.q, query.limit);
  }

  /** The menus this person may use, and the full list to choose from. */
  @Get(':id/access')
  @Can(TenantPolicy, 'administer')
  getAccess(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.getAccess(actor, id);
  }

  /** Replaces their menus with `accessKeys`; an empty list removes all. */
  @Put(':id/access')
  @Can(TenantPolicy, 'administer')
  setAccess(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetMemberAccessDto,
  ) {
    return this.members.setAccess(actor, id, dto.accessKeys);
  }

  @Get(':id')
  @Can(TenantPolicy, 'administer')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.get(actor, id);
  }

  @Post()
  @Can(TenantPolicy, 'administer')
  add(@CurrentActor() actor: Actor, @Body() dto: AddMemberDto) {
    return this.members.add(actor, dto);
  }

  @Patch(':id')
  @Can(TenantPolicy, 'administer')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.members.update(actor, id, dto);
  }

  @Put(':id/password')
  @HttpCode(204)
  @Can(TenantPolicy, 'administer')
  async setPassword(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetMemberPasswordDto,
  ) {
    await this.members.setPassword(actor, id, dto.password);
  }

  @Delete(':id')
  @HttpCode(204)
  @Can(TenantPolicy, 'administer')
  async remove(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    await this.members.remove(actor, id);
  }
}
