import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClientImportRow } from '../db/schema.js';
import type { TenantTx } from '../db/tenant-db.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { ClientImportsRepository } from './client-imports.repository.js';
import {
  type Client,
  ClientsRepository,
} from './clients.repository.js';
import type {
  CreateClientDto,
  DeleteClientsDto,
  ImportClientsDto,
  UpdateClientDto,
} from './dto/clients.dto.js';

const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** Blank optional contact details are stored as null, not empty strings. */
export const normalizeContact = (value?: string | null): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** A client must stay reachable by email or by phone. */
export const assertContact = (email: string | null, phone: string | null) => {
  if (!email && !phone) {
    throw new BadRequestException('Provide an email or a phone number');
  }
};

/** Client records inside the actor's own company (all through TenantDb). */
@Injectable()
export class ClientsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly clients: ClientsRepository,
    private readonly imports: ClientImportsRepository,
  ) {}

  /** One page of the company's clients, with what the table footer needs. */
  async list(actor: Actor, page: number, pageSize: number, q?: string, importId?: string) {
    const { items, total } = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.clients.page(tx, page, pageSize, q, importId),
    );
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  get(actor: Actor, id: string): Promise<Client> {
    return this.tenantDb.run(actor.tenant.id, (tx) => this.findOrFail(tx, id));
  }

  create(actor: Actor, dto: CreateClientDto): Promise<Client> {
    const email = normalizeContact(dto.email);
    const phone = normalizeContact(dto.phone);
    assertContact(email, phone);
    return this.tenantDb.run(actor.tenant.id, (tx) =>
      this.clients.create(tx, {
        tenantId: actor.tenant.id,
        name: dto.name,
        email,
        phone,
        customDetails: { ...dto.customDetails },
      }),
    );
  }

  update(actor: Actor, id: string, dto: UpdateClientDto): Promise<Client> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const target = await this.findOrFail(tx, id);
      const email =
        dto.email === undefined ? target.email : normalizeContact(dto.email);
      const phone =
        dto.phone === undefined ? target.phone : normalizeContact(dto.phone);
      assertContact(email, phone);
      return (await this.clients.update(tx, id, {
        email,
        phone,
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.customDetails === undefined
          ? {}
          : { customDetails: { ...dto.customDetails } }),
      }))!;
    });
  }

  /**
   * One chunk of a registered import: the import must belong to this company,
   * valid rows become clients with `importId` set, and unusable rows are
   * skipped. The raw payload and both counters are recorded in one statement.
   */
  async importChunk(actor: Actor, dto: ImportClientsDto) {
    let created = 0;
    let skipped = 0;
    const storedRows: ClientImportRow[] = [];
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const rowImport = await this.imports.find(tx, dto.importId);
      if (!rowImport) throw new NotFoundException('Import not found');

      for (const row of dto.clients) {
        const name = row.name?.trim();
        const email = normalizeContact(row.email);
        const phone = normalizeContact(row.phone);
        storedRows.push({
          name: name ?? '',
          email,
          phone,
          customDetails: { ...row.customDetails },
        });
        if (!name || (!email && !phone) || (email && !EMAIL_RE.test(email))) {
          skipped += 1;
          continue;
        }
        await this.clients.create(tx, {
          tenantId: actor.tenant.id,
          importId: rowImport.id,
          name,
          email,
          phone,
          customDetails: { ...row.customDetails },
        });
        created += 1;
      }
      await this.imports.recordChunk(tx, rowImport.id, created, skipped, storedRows);
    });
    return { created, skipped };
  }

  /** Chunked bulk delete; import counters follow the clients that were removed. */
  async removeMany(actor: Actor, dto: DeleteClientsDto) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      let deleted = 0;
      for (let index = 0; index < dto.ids.length; index += 100) {
        const chunk = dto.ids.slice(index, index + 100);
        const found = await this.clients.findByIds(tx, chunk);
        if (!found.length) continue;
        await this.clients.removeByIds(tx, found.map((client) => client.id));
        deleted += found.length;

        const perImport = new Map<string, number>();
        for (const client of found) {
          if (client.importId) perImport.set(client.importId, (perImport.get(client.importId) ?? 0) + 1);
        }
        for (const [importId, amount] of perImport) {
          await this.imports.decrementCreated(tx, importId, amount);
        }
      }
      return { deleted };
    });
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const client = await this.findOrFail(tx, id);
      await this.clients.remove(tx, id);
      if (client.importId) await this.imports.decrementCreated(tx, client.importId, 1);
    });
  }

  private async findOrFail(tx: TenantTx, id: string): Promise<Client> {
    const client = await this.clients.find(tx, id);
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }
}
