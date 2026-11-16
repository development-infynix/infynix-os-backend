import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The Drizzle database injected with `@InjectDrizzle()`. */
export type Database = NodePgDatabase;
