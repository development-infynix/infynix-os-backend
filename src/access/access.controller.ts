import { Controller, Get } from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { TenantPolicy } from '../tenancy/tenant.policy.js';
import { AccessService } from './access.service.js';

/** The grantable list itself. Owners read it; the API never changes it at runtime. */
@Controller('access')
export class AccessController {
  constructor(private readonly access: AccessService) {}

  @Get('items')
  @Can(TenantPolicy, 'administer')
  async items() {
    return { items: await this.access.menuItems() };
  }
}
