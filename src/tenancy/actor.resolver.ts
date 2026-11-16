import {
  createParamDecorator,
  ForbiddenException,
  Injectable,
  type ExecutionContext,
} from '@nestjs/common';
import type { AuthUser } from '../users/user.types.js';
import type { Actor } from './tenancy.types.js';
import { TenantsRepository } from './tenants.repository.js';

interface ActorRequest {
  user?: AuthUser;
  actor?: Actor | null;
}

/**
 * Builds the Actor for a request: the signed-in person and their company.
 * Plugged into @nestjs/authorization as `getUser`, so every policy receives
 * an Actor. Cached on the request. A suspended company is refused here, for
 * everyone but platform admins.
 */
@Injectable()
export class ActorResolver {
  constructor(private readonly tenants: TenantsRepository) {}

  async resolve(context: ExecutionContext): Promise<Actor | null> {
    if (context.getType() !== 'http') return null;
    const request = context.switchToHttp().getRequest<ActorRequest>();
    if (request.actor !== undefined) return request.actor;

    const user = request.user;
    if (!user) return (request.actor = null);

    const tenant = await this.tenants.findById(user.tenantId);
    if (!tenant) return (request.actor = null);
    if (tenant.status === 'suspended' && !user.isPlatformAdmin) {
      throw new ForbiddenException('Your company’s account is suspended. Contact Infynix support.');
    }
    return (request.actor = { user, tenant });
  }
}

/** The resolved Actor (set by the authorization guard on routes with @Can). */
export const CurrentActor = createParamDecorator(
  (_: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<ActorRequest>().actor as Actor,
);
