import helmet from '@fastify/helmet';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );
  const config = app.get(ConfigService);

  await app.register(helmet);
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    // Comma-separated list of allowed frontend origins, e.g. https://app.infynix.com
    origin: config
      .get<string>('CORS_ORIGINS', 'http://localhost:5173')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
    // @fastify/cors allows only GET/HEAD/POST by default; the API also edits
    // (PATCH), replaces (PUT) and deletes.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3001);
  // 0.0.0.0 is required for Fastify to be reachable inside Docker / on hosts
  await app.listen(port, '0.0.0.0');
  console.log(`[infynix-api] listening on http://localhost:${port}/api/v1`);
}
await bootstrap();
