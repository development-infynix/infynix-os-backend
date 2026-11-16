/**
 * Applies pending migrations from ./drizzle. Run from the backend folder:
 *   pnpm db:migrate
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { loadEnv } from './load-env.js';
import { pgPoolConfig } from './pg-config.js';

loadEnv();
const pool = new Pool(pgPoolConfig(process.env, { unpooled: true }));

try {
  await migrate(drizzle({ client: pool }), { migrationsFolder: './drizzle' });
  console.log('[db:migrate] migrations applied');
} catch (error) {
  console.error('[db:migrate] failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
