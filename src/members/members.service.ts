import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PasswordHasher, SessionService } from '@nestjs/authentication';
import { AccessService } from '../access/access.service.js';
import { TenantDb, type TenantTx } from '../db/tenant-db.js';
import { TenantPolicy } from '../tenancy/tenant.policy.js';
import type { Actor, MemberRole } from '../tenancy/tenancy.types.js';
import type { AddMemberDto, UpdateMemberDto } from './dto/members.dto.js';
import { type Member, MembersRepository } from './members.repository.js';

const EMAIL_IN_USE = 'This email is already used by another account';
import { isUniqueViolation } from '../db/errors.js';

/** People management inside the actor's own company (all through TenantDb). */
@Injectable()
export class MembersService {
  private readonly policy = new TenantPolicy();

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly members: MembersRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: SessionService,
    private readonly access: AccessService,
  ) {}

  /** Users of the company matching a search (name or email). */
  async search(actor: Actor, query: string, limit: number) {
    const items = await this.tenantDb.run(actor.tenant.id, (tx) => this.members.search(tx, query, limit));
    return { items };
  }

  /** One user of the company (404 when they're not in it). */
  get(actor: Actor, id: string): Promise<Member> {
    return this.tenantDb.run(actor.tenant.id, (tx) => this.findOrFail(tx, id));
  }

  /** One page of the company's users, with what the table footer needs. */
  async list(actor: Actor, page: number, pageSize: number) {
    const { items, total } = await this.tenantDb.run(actor.tenant.id, (tx) =>
      this.members.page(tx, page, pageSize),
    );
    return { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  /**
   * The menus one person may use. The owner holds every menu implicitly, so
   * their list is the full access list even though `user_access` has no rows.
   */
  async getAccess(actor: Actor, id: string) {
    const items = await this.access.menuItems();
    const accessKeys = await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const target = await this.findOrFail(tx, id);
      if (target.role === 'owner') return items.map((item) => item.key);
      return this.access.grantedKeys(tx, id);
    });
    return { items, accessKeys };
  }

  /** Replaces an employee's menus. They see the change on their next request. */
  async setAccess(actor: Actor, id: string, keys: string[]) {
    const normalized = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const target = await this.findOrFail(tx, id);
      this.assertMayManage(actor, target.role);
      if (target.role === 'owner') {
        throw new BadRequestException('The owner already has access to every menu');
      }
      await this.access.replace(tx, {
        tenantId: actor.tenant.id,
        userId: id,
        grantedBy: actor.user.id,
        keys: normalized,
      });
    });
    return this.getAccess(actor, id);
  }

  /** The owner creates an employee with a starting password and a role. */
  async add(actor: Actor, dto: AddMemberDto): Promise<Member> {
    this.assertMayAssign(actor, dto.role);
    const passwordHash = await this.hasher.hash(dto.password);
    try {
      return await this.tenantDb.run(actor.tenant.id, (tx) =>
        this.members.create(tx, {
          tenantId: actor.tenant.id,
          email: dto.email,
          fullName: dto.fullName,
          role: dto.role,
          passwordHash,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(EMAIL_IN_USE);
      throw error;
    }
  }

  async update(actor: Actor, id: string, dto: UpdateMemberDto): Promise<Member> {
    let updated: Member;
    try {
      updated = await this.updateInCompany(actor, id, dto);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(EMAIL_IN_USE);
      throw error;
    }
    // Roles are re-read on every request; a deactivated person is also signed out now.
    if (!updated.isActive) await this.sessions.revokeAll(id);
    return updated;
  }

  private updateInCompany(actor: Actor, id: string, dto: UpdateMemberDto): Promise<Member> {
    return this.tenantDb.run(actor.tenant.id, async (tx) => {
      const target = await this.findOrFail(tx, id);
      this.assertMayManage(actor, target.role);

      const roleChanges = dto.role !== undefined && dto.role !== target.role;
      const deactivates = dto.isActive === false && target.isActive;
      if (roleChanges) this.assertMayAssign(actor, dto.role!);
      if (actor.user.id === id && (roleChanges || deactivates)) {
        throw new BadRequestException("You can't change your own role or deactivate yourself");
      }
      if (target.role === 'owner' && target.isActive && (roleChanges || deactivates)) {
        await this.assertNotLastOwner(tx);
      }
      return (await this.members.update(tx, id, dto))!;
    });
  }

  /** Sets a new password for an employee and signs them out everywhere. */
  async setPassword(actor: Actor, id: string, password: string): Promise<void> {
    if (actor.user.id === id) {
      throw new BadRequestException('Change your own password from your profile');
    }
    const passwordHash = await this.hasher.hash(password);
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const target = await this.findOrFail(tx, id);
      this.assertMayManage(actor, target.role);
      await this.members.setPassword(tx, id, passwordHash);
    });
    await this.sessions.revokeAll(id);
  }

  /** Deletes the employee's account (their sessions go with it). */
  async remove(actor: Actor, id: string): Promise<void> {
    await this.tenantDb.run(actor.tenant.id, async (tx) => {
      const target = await this.findOrFail(tx, id);
      this.assertMayManage(actor, target.role);
      if (actor.user.id === id) throw new BadRequestException("You can't remove yourself");
      if (target.role === 'owner' && target.isActive) await this.assertNotLastOwner(tx);
      await this.members.remove(tx, id);
    });
  }

  private assertMayAssign(actor: Actor, role: MemberRole) {
    if (!this.policy.assignRole(actor, role)) {
      throw new ForbiddenException(
        role === 'owner' ? 'A company has one owner; give managers or staff instead' : 'Only the company owner can manage users',
      );
    }
  }

  private assertMayManage(actor: Actor, targetRole: MemberRole) {
    if (!this.policy.manage(actor, targetRole)) {
      throw new ForbiddenException('Only the company owner can manage users');
    }
  }

  private async findOrFail(tx: TenantTx, id: string): Promise<Member> {
    const member = await this.members.find(tx, id);
    if (!member) throw new NotFoundException('Person not found');
    return member;
  }

  private async assertNotLastOwner(tx: TenantTx) {
    if ((await this.members.countActiveOwners(tx)) <= 1) {
      throw new ConflictException('Your company needs at least one active owner');
    }
  }
}
