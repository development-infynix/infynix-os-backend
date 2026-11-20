import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ClientImportRow } from '../db/schema.js';
import { isUniqueViolation } from '../db/errors.js';
import type { TenantTx } from '../db/tenant-db.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import { ClientImportsRepository } from './client-imports.repository.js';
import {
  type Client,
  type DuplicateClient,
  type ImportRowData,
  ClientsRepository,
  contactKeys,
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

/** "A client with this email already exists: Vishnu Nair." */
export const duplicateMessage = (duplicate: DuplicateClient) =>
  `A client with this ${duplicate.matchedOn === 'email' ? 'email' : 'phone number'} already exists: ${duplicate.name}.`;

/** Client records inside the actor's own company (all through TenantDb). */
@Injectable()
export class ClientsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly clients: ClientsRepository,
    private readonly imports: ClientImportsRepository,
  ) {}

  /** Client ids from one import, for "Select imports" on the Clients page. */
  idsForImport(actor: Actor, importId: string): Promise<string[]> {
    return this.tenantDb.run(actor.tenant.id, (tx) => this.clients.idsForImport(tx, importId));
  }

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

  /** A person already in the directory (same email or phone) is refused with 409, naming them. */
  async create(actor: Actor, dto: CreateClientDto): Promise<Client> {
    const email = normalizeContact(dto.email);
    const phone = normalizeContact(dto.phone);
    assertContact(email, phone);
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        const duplicate = await this.clients.findDuplicate(tx, actor.tenant.id, { email, phone });
        if (duplicate) throw new ConflictException(duplicateMessage(duplicate));
        return this.clients.create(tx, {
          tenantId: actor.tenant.id,
          name: dto.name,
          email,
          phone,
          customDetails: { ...dto.customDetails },
        });
      });
    } catch (error) {
      // Someone added the same person a moment ago, after our check.
      if (isUniqueViolation(error)) {
        throw new ConflictException('A client with this email or phone number already exists.');
      }
      throw error;
    }
  }

  /** Changing the email or phone to another client's is refused with 409, naming them. */
  async update(actor: Actor, id: string, dto: UpdateClientDto): Promise<Client> {
    try {
      return await this.tenantDb.run(actor.tenant.id, async (tx) => {
        const target = await this.findOrFail(tx, id);
        const email =
          dto.email === undefined ? target.email : normalizeContact(dto.email);
        const phone =
          dto.phone === undefined ? target.phone : normalizeContact(dto.phone);
        assertContact(email, phone);
        const duplicate = await this.clients.findDuplicate(tx, actor.tenant.id, { email, phone }, id);
        if (duplicate) throw new ConflictException(duplicateMessage(duplicate));
        return (await this.clients.update(tx, id, {
          email,
          phone,
          ...(dto.name === undefined ? {} : { name: dto.name }),
          ...(dto.customDetails === undefined
            ? {}
            : { customDetails: { ...dto.customDetails } }),
        }))!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('A client with this email or phone number already exists.');
      }
      throw error;
    }
  }

  /**
   * One chunk of a registered import, in one statement. Rows with no name, no
   * contact or a bad email are skipped as invalid. Rows whose email or phone
   * already belongs to a client in this company (or to an earlier row of this
   * chunk) are skipped as duplicates: the client is not created again.
   * `existingClientIds` are the clients those duplicates matched, so the CRM's
   * Import data can still add them to its pipeline.
   */
  async importChunk(actor: Actor, dto: ImportClientsDto) {
    const storedRows: ClientImportRow[] = [];
    const rows: ImportRowData[] = [];
    const seenEmails = new Set<string>();
    const seenPhones = new Set<string>();
    let invalid = 0;
    let repeatedInChunk = 0;
    for (const row of dto.clients) {
      const name = row.name?.trim();
      const email = normalizeContact(row.email);
      const phone = normalizeContact(row.phone);
      storedRows.push({ name: name ?? '', email, phone, customDetails: { ...row.customDetails } });
      if (!name || (!email && !phone) || (email && !EMAIL_RE.test(email))) {
        invalid += 1;
        continue;
      }
      const keys = contactKeys(email, phone);
      if ((keys.email && seenEmails.has(keys.email)) || (keys.phone && seenPhones.has(keys.phone))) {
        repeatedInChunk += 1;
        continue;
      }
      if (keys.email) seenEmails.add(keys.email);
      if (keys.phone) seenPhones.add(keys.phone);
      rows.push({ name, email, phone, customDetails: { ...row.customDetails } });
    }

    const result = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.clients.importRows(tx, {
        tenantId: actor.tenant.id,
        importId: dto.importId,
        rows,
        invalid,
        repeatedInChunk,
        storedRows,
      }),
    );
    if (!result) throw new NotFoundException('Import not found');
    return {
      created: result.created,
      skipped: invalid,
      duplicates: result.duplicates,
      existingClientIds: result.existingIds,
    };
  }

  /** Bulk delete (up to 500 ids); import counters follow the clients that were removed. */
  async removeMany(actor: Actor, dto: DeleteClientsDto) {
    return this.tenantDb.run(actor.tenant.id, async (tx) => ({
      deleted: await this.clients.removeMany(tx, dto.ids),
    }));
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
