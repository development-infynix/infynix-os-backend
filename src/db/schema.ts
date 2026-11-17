import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

/* ── Tenancy primitives ─────────────────────────────────────────────────── */

/** Roles a person can hold inside one company, highest first. */
export const MEMBER_ROLES = ['owner', 'manager', 'staff'] as const;
export const memberRole = pgEnum('member_role', MEMBER_ROLES);

export const TENANT_STATUSES = ['active', 'suspended'] as const;
export const tenantStatus = pgEnum('tenant_status', TENANT_STATUSES);

/**
 * Menu items are access items; future capabilities (creating a client,
 * exporting an invoice) join the same list as `action` items.
 */
export const ACCESS_KINDS = ['menu', 'action'] as const;
export const accessKind = pgEnum('access_kind', ACCESS_KINDS);

/**
 * The restricted database role every company-scoped query runs as
 * (`SET LOCAL ROLE`, see TenantDb). It can't log in and doesn't bypass
 * row-level security, unlike the connection's owner role.
 */
export const tenantRole = pgRole('infynix_tenant');

/** Rows of a company-owned table are visible only inside that company's transaction. */
const currentTenant = sql`(nullif(current_setting('app.tenant_id', true), ''))::uuid`;
const tenantIsolation = (tenantId: AnyPgColumn) =>
  pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    to: tenantRole,
    using: sql`${tenantId} = ${currentTenant}`,
    withCheck: sql`${tenantId} = ${currentTenant}`,
  });

/* ── Global tables (no tenant) ──────────────────────────────────────────── */

/** A person: one login, in exactly one company, with one role there. */
export const users = pgTable.withRLS(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Stored lowercased; the unique index on lower(email) backs that up. */
    email: text().notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    role: memberRole().notNull().default('staff'),
    /** Infynix staff: can see and suspend any company. */
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    /** Deactivated people can't sign in and lose their sessions. */
    isActive: boolean('is_active').notNull().default(true),
    emailVerified: boolean('email_verified').notNull().default(false),
    lastLoginAt: timestamptz('last_login_at'),
    passwordChangedAt: timestamptz('password_changed_at')
      .notNull()
      .defaultNow(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('users_email_lower_key').on(sql`lower(${t.email})`),
    index('users_tenant_id_idx').on(t.tenantId),
    tenantIsolation(t.tenantId),
  ],
);

/** A client company, created by self-serve sign-up. */
export const tenants = pgTable('tenants', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  status: tenantStatus().notNull().default('active'),
  /** Reserved for billing; every company is on `free` for now. */
  plan: text().notNull().default('free'),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * Everything a person can be granted: the sidebar menus today, and other
 * capabilities later (`kind = 'action'`). The list is global on purpose:
 * every company sees the same menus, only the grants differ.
 */
export const accessItems = pgTable(
  'access_items',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Stable identifier used by the API and the frontend (`clients`, `crm`, ...). */
    key: text().notNull(),
    label: text().notNull(),
    kind: accessKind().notNull().default('menu'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex('access_items_key_key').on(t.key),
    index('access_items_kind_sort_idx').on(t.kind, t.sortOrder),
  ],
);

/**
 * A grant: this person may use this access item. Absence means no access.
 * Owners are implicit (they get everything without rows, see AccessService).
 */
export const userAccess = pgTable.withRLS(
  'user_access',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessItemId: uuid('access_item_id')
      .notNull()
      .references(() => accessItems.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    grantedAt: timestamptz('granted_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('user_access_user_item_key').on(t.userId, t.accessItemId),
    index('user_access_tenant_idx').on(t.tenantId),
    index('user_access_user_idx').on(t.userId),
    tenantIsolation(t.tenantId),
  ],
);

/**
 * Server-side sessions for @nestjs/authentication. A session belongs to a
 * person; their company is on the users row.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    lastActiveAt: timestamptz('last_active_at').notNull(),
    mfa: text(),
    metadata: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

/* ── Company-owned records ────────────────────────────────────────────────── */

/** One normalized spreadsheet row kept with the import it came from. */
export interface ClientImportRow {
  name: string;
  email: string | null;
  phone: string | null;
  customDetails: Record<string, unknown>;
}

/**
 * A client import started in the UI. The raw rows are appended as the
 * frontend uploads chunks; counts are incremented for accepted/rejected rows.
 */
export const clientImports = pgTable.withRLS(
  'client_imports',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    fileName: text('file_name').notNull(),
    rowCount: integer('row_count').notNull(),
    createdCount: integer('created_count').notNull().default(0),
    skippedCount: integer('skipped_count').notNull().default(0),
    rows: jsonb('rows').$type<ClientImportRow[]>().notNull().default([]),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('client_imports_tenant_id_idx').on(t.tenantId),
    check('client_imports_row_count_max', sql`${t.rowCount} <= 500`),
    check('client_imports_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('client_imports_file_name_not_blank', sql`length(btrim(${t.fileName})) > 0`),
    tenantIsolation(t.tenantId),
  ],
);

/** A customer of the company, with the contact details the frontend collects. */
export const clients = pgTable.withRLS(
  'clients',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    email: text(),
    phone: text(),
    /** Null for clients created before imports or added one by one. */
    importId: uuid('import_id').references((): AnyPgColumn => clientImports.id, {
      onDelete: 'set null',
    }),
    customDetails: jsonb('custom_details')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('clients_tenant_id_idx').on(t.tenantId),
    index('clients_import_id_idx').on(t.importId),
    check('clients_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check(
      'clients_contact_required',
      sql`${t.email} is not null or ${t.phone} is not null`,
    ),
    tenantIsolation(t.tenantId),
  ],
);
