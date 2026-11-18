import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import type { ClientImport, ClientImportSummary } from './client-imports.repository.js';
import { ClientImportsRepository } from './client-imports.repository.js';
import type { CreateClientImportDto, ImportNameDto } from './dto/client-imports.dto.js';

/** Import records inside the actor's own company (all through TenantDb). */
@Injectable()
export class ClientImportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly imports: ClientImportsRepository,
  ) {}

  create(actor: Actor, dto: CreateClientImportDto): Promise<ClientImportSummary> {
    return this.tenantDb.run(actor.tenant.id, (tx) =>
      this.imports.create(tx, {
        tenantId: actor.tenant.id,
        name: dto.name,
        fileName: dto.fileName,
        rowCount: dto.rowCount,
        createdBy: actor.user.id,
      }),
    );
  }

  list(actor: Actor): Promise<ClientImportSummary[]> {
    return this.tenantDb.run(actor.tenant.id, (tx) => this.imports.list(tx));
  }

  async get(actor: Actor, id: string): Promise<ClientImport> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const row = await this.imports.find(tx, id);
      if (!row) throw new NotFoundException('Import not found');
      return row;
    });
  }

  rename(actor: Actor, id: string, dto: ImportNameDto): Promise<ClientImportSummary> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const row = await this.imports.rename(tx, id, dto.name);
      if (!row) throw new NotFoundException('Import not found');
      return row;
    });
  }

  deleteClientChunk(actor: Actor, id: string, limit: number) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const row = await this.imports.find(tx, id);
      if (!row) throw new NotFoundException('Import not found');
      return this.imports.deleteClientChunk(tx, id, limit);
    });
  }

  async remove(actor: Actor, id: string): Promise<number> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const row = await this.imports.find(tx, id);
      if (!row) throw new NotFoundException('Import not found');
      return this.imports.removeWithClients(tx, id);
    });
  }
}
