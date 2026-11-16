import { Test } from '@nestjs/testing';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    controller = module.get(HealthController);
  });

  it('reports ok', () => {
    expect(controller.check()).toMatchObject({
      status: 'ok',
      service: 'infynix-api',
    });
  });
});
