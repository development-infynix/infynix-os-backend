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
import { ClientImportsService } from './client-imports.service.js';
import {
  CreateClientImportDto,
  DeleteImportChunkQuery,
  ImportNameDto,
} from './dto/client-imports.dto.js';

/** Admin › Clients imports: /api/v1/client-imports, behind the clients grant. */
@Controller('client-imports')
export class ClientImportsController {
  constructor(private readonly imports: ClientImportsService) {}

  @Post()
  @Can(ClientPolicy, 'use')
  create(@CurrentActor() actor: Actor, @Body() dto: CreateClientImportDto) {
    return this.imports.create(actor, dto);
  }

  /** Summaries only: the rows payload is available on the detail route. */
  @Get()
  @Can(ClientPolicy, 'use')
  list(@CurrentActor() actor: Actor) {
    return this.imports.list(actor);
  }

  @Get(':id')
  @Can(ClientPolicy, 'use')
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(actor, id);
  }

  @Patch(':id')
  @Can(ClientPolicy, 'use')
  rename(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ImportNameDto,
  ) {
    return this.imports.rename(actor, id, dto);
  }

  @Delete(':id/clients')
  @Can(ClientPolicy, 'use')
  deleteClientChunk(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: DeleteImportChunkQuery,
  ) {
    return this.imports.deleteClientChunk(actor, id, query.limit);
  }

  @Delete(':id')
  @HttpCode(204)
  @Can(ClientPolicy, 'use')
  async remove(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    await this.imports.remove(actor, id);
  }
}
