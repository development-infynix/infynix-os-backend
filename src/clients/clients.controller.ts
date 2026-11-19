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
  Query,
} from '@nestjs/common';
import { CurrentActor } from '../tenancy/actor.resolver.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { ClientPolicy } from './client.policy.js';
import { ClientsService } from './clients.service.js';
import {
  ClientIdsQuery,
  CreateClientDto,
  DeleteClientsDto,
  ImportClientsDto,
  ListClientsQuery,
  UpdateClientDto,
} from './dto/clients.dto.js';

/** Admin › Clients: /api/v1/clients, guarded by the clients menu grant. */
@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @Can(ClientPolicy, 'use')
  list(@CurrentActor() actor: Actor, @Query() query: ListClientsQuery) {
    return this.clients.list(actor, query.page, query.pageSize, query.q, query.importId);
  }

  /** Every client id from one import. Declared before `:id` so "ids" isn't read as an id. */
  @Get('ids')
  @Can(ClientPolicy, 'use')
  async ids(@CurrentActor() actor: Actor, @Query() query: ClientIdsQuery) {
    return { ids: await this.clients.idsForImport(actor, query.importId) };
  }

  @Get(':id')
  @Can(ClientPolicy, 'use')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.clients.get(actor, id);
  }

  /** One chunk of an import, at most 100 rows per request. */
  @Post('import')
  @Can(ClientPolicy, 'use')
  importChunk(@CurrentActor() actor: Actor, @Body() dto: ImportClientsDto) {
    return this.clients.importChunk(actor, dto);
  }

  @Post()
  @Can(ClientPolicy, 'use')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateClientDto) {
    return this.clients.create(actor, dto);
  }

  @Patch(':id')
  @Can(ClientPolicy, 'use')
  update(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClientDto,
  ) {
    return this.clients.update(actor, id, dto);
  }

  /** Chunked delete of selected clients; import counts are adjusted too. */
  @Delete()
  @Can(ClientPolicy, 'use')
  removeMany(@CurrentActor() actor: Actor, @Body() dto: DeleteClientsDto) {
    return this.clients.removeMany(actor, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @Can(ClientPolicy, 'use')
  async remove(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    await this.clients.remove(actor, id);
  }
}
