import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` diffs the schema against ./drizzle and writes a new
// migration; it doesn't connect to the database. Apply with `pnpm db:migrate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Manage our own roles (infynix_tenant), never Neon's built-in ones.
  entities: { roles: { provider: 'neon' } },
});
