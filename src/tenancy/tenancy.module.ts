import { Module } from '@nestjs/common';
import { TenantDb } from '../db/tenant-db.js';
import { ActorResolver } from './actor.resolver.js';
import { TenantPolicy } from './tenant.policy.js';
import { TenantsRepository } from './tenants.repository.js';

@Module({
  providers: [TenantsRepository, ActorResolver, TenantPolicy, TenantDb],
  exports: [TenantsRepository, ActorResolver, TenantDb, TenantPolicy],
})
export class TenancyModule {}
