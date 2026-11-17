import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantTx } from '../db/tenant-db.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Actor } from '../tenancy/tenancy.types.js';
import {
  type Client,
  ClientsRepository,
} from './clients.repository.js';
import type {
  CreateClientDto,
  ImportClientRowDto,
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
  ) {}

  /** One page of the company's clients, with what the table footer needs. */
  async list(actor: Actor, page: number, pageSize: number, q?: string) {
    const { items, total } = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.clients.page(tx, page, pageSize, q),
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

  /** One import chunk: valid rows are created, unusable rows are counted as skipped. */
  async importChunk(actor: Actor, rows: ImportClientRowDto[]) {
    let created = 0;
    let skipped = 0;
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      for (const row of rows) {
        const name = row.name?.trim();
        const email = normalizeContact(row.email);
        const phone = normalizeContact(row.phone);
        if (!name || (!email && !phone) || (email && !EMAIL_RE.test(email))) {
          skipped += 1;
          continue;
        }
        await this.clients.create(tx, {
          tenantId: actor.tenant.id,
          name,
          email,
          phone,
          customDetails: { ...row.customDetails },
        });
        created += 1;
      }
    });
    return { created, skipped };
  }

  async remove(actor: Actor, id: string): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      await this.findOrFail(tx, id);
      await this.clients.remove(tx, id);
    });
  }

  private async findOrFail(tx: TenantTx, id: string): Promise<Client> {
    const client = await this.clients.find(tx, id);
    if (!client) throw new NotFoundException('Client not found');
    return client;
  }
}
