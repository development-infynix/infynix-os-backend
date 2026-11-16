import { Controller, Get } from '@nestjs/common';
import { Public } from '@nestjs/authentication';

@Public()
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      service: 'infynix-api',
      uptime: Math.round(process.uptime()),
    };
  }
}
