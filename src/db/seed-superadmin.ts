/**
 * Creates the Infynix company and its owner, who is also the platform admin
 * (Infynix staff). Run from the backend folder after migrating:
 *   pnpm db:seed
 *
 * Reads SEED_SUPERADMIN_EMAIL, SEED_SUPERADMIN_PASSWORD, SEED_SUPERADMIN_NAME
 * and SEED_TENANT_NAME (default "Infynix"). Does nothing if the email already
 * exists, so it's safe to run again. Remove the password from .env once it
 * has run.
 */
import { PasswordHasher } from '@nestjs/authentication';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { describePasswordProblems, passwordProblems } from '../auth/password-policy.js';
import { loadEnv } from './load-env.js';
import { pgPoolConfig } from './pg-config.js';
import { tenants, users } from './schema.js';

loadEnv();

const email = process.env.SEED_SUPERADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.SEED_SUPERADMIN_PASSWORD;
const fullName = process.env.SEED_SUPERADMIN_NAME?.trim() || 'Super Admin';
const companyName = process.env.SEED_TENANT_NAME?.trim() || 'Infynix';

if (!email || !password) {
  console.error('[db:seed] SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must be set');
  process.exit(1);
}
const problems = passwordProblems(password);
if (problems.length) {
  console.error(`[db:seed] ${describePasswordProblems(problems)}`);
  process.exit(1);
}

const pool = new Pool(pgPoolConfig(process.env, { unpooled: true }));
const db = drizzle({ client: pool });

try {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email));

  if (existing) {
    console.log(`[db:seed] ${email} already exists; nothing changed`);
  } else {
    const passwordHash = await new PasswordHasher().hash(password);
    await db.transaction(async (tx) => {
      const [tenant] = await tx.insert(tenants).values({ name: companyName }).returning({ id: tenants.id });
      const [owner] = await tx
        .insert(users)
        .values({
          email,
          fullName,
          passwordHash,
          tenantId: tenant.id,
          role: 'owner',
          isPlatformAdmin: true,
          emailVerified: true,
        })
        .returning({ id: users.id });
      await tx.update(tenants).set({ createdBy: owner.id }).where(eq(tenants.id, tenant.id));
    });
    console.log(`[db:seed] ${companyName} created; ${email} is its owner and platform admin`);
  }
} catch (error) {
  console.error('[db:seed] failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
