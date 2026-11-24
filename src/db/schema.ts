import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  type PgTableExtraConfigValue,
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
    // Target for same-company foreign keys (e.g. pipeline access rows).
    uniqueIndex('users_tenant_id_id_key').on(t.tenantId, t.id),
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
    userId: uuid('user_id').notNull(),
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
    // The person must belong to the same company as the grant.
    foreignKey({
      name: 'user_access_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
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
    // Target for same-company foreign keys (clients.import_id).
    uniqueIndex('client_imports_tenant_id_id_key').on(t.tenantId, t.id),
    check('client_imports_row_count_max', sql`${t.rowCount} <= 500`),
    check('client_imports_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check(
      'client_imports_file_name_not_blank',
      sql`length(btrim(${t.fileName})) > 0`,
    ),
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
    importId: uuid('import_id'),
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
    // The import must belong to the same company. Deleting an import clears
    // only import_id: the migration writes ON DELETE SET NULL ("import_id")
    // (Postgres 15+), which drizzle can't express; plain SET NULL would also
    // null tenant_id, which can't be null. A null import_id always passes.
    foreignKey({
      name: 'clients_import_fk',
      columns: [t.tenantId, t.importId],
      foreignColumns: [clientImports.tenantId, clientImports.id],
    }).onDelete('set null'),
    // Lets the CRM reference a client through (tenant_id, id), so a deal can
    // never point at another company's client even if RLS is bypassed.
    uniqueIndex('clients_tenant_id_id_key').on(t.tenantId, t.id),
    // No duplicate people within a company (the same person may be a client
    // of two companies). Email matches ignoring case and spaces; phone matches
    // on digits only, so "+91 80035 09196" = "+918003509196". The app checks
    // first and reports duplicates; these make it airtight under concurrency.
    // Queries that look clients up by contact must use these exact expressions.
    uniqueIndex('clients_tenant_email_key')
      .on(t.tenantId, sql`lower(btrim(${t.email}))`)
      .where(sql`${t.email} is not null`),
    uniqueIndex('clients_tenant_phone_key')
      .on(t.tenantId, sql`regexp_replace(${t.phone}, '\\D', '', 'g')`)
      .where(sql`regexp_replace(${t.phone}, '\\D', '', 'g') <> ''`),
    check('clients_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check(
      'clients_contact_required',
      sql`${t.email} is not null or ${t.phone} is not null`,
    ),
    tenantIsolation(t.tenantId),
  ],
);

/* ── CRM ─────────────────────────────────────────────────────────────────── */

/**
 * How a pipeline picks the owner of new deals, and how a deal's current owner
 * was assigned (see docs/user-deals-assignment.md). `manual` as a source means
 * a person picked the owner in the deal drawer.
 */
export const CRM_ASSIGNMENT_RULES = [
  'creator',
  'manual',
  'round_robin',
  'single_user',
] as const;
export type CrmAssignmentRule = (typeof CRM_ASSIGNMENT_RULES)[number];
const assignmentValues = sql.raw(
  CRM_ASSIGNMENT_RULES.map((rule) => `'${rule}'`).join(', '),
);

/**
 * A pipeline owns an ordered list of stages and the deals inside it. Every
 * company has at least one; `list()` creates a default "Sales" pipeline the
 * first time the CRM is opened.
 */
export const crmPipelines = pgTable.withRLS(
  'crm_pipelines',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /** Order in the pipeline picker; lower first. */
    position: integer().notNull().default(0),
    /** Who owns deals added from now on. */
    assignmentRule: text('assignment_rule')
      .$type<CrmAssignmentRule>()
      .notNull()
      .default('creator'),
    /** The `single_user` rule's person; must be on this pipeline's access list. */
    singleUserId: uuid('single_user_id'),
    /** Where round robin carries on: shared by the rule and the Share tool. */
    roundRobinCursor: integer('round_robin_cursor').notNull().default(0),
    /** Who created it (null for the seeded default and pipelines made before this was recorded). */
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  // Annotated: pipelines and their access list reference each other.
  (t): PgTableExtraConfigValue[] => [
    index('crm_pipelines_tenant_id_idx').on(t.tenantId),
    check(
      'crm_pipelines_assignment_rule',
      sql`${t.assignmentRule} in (${assignmentValues})`,
    ),
    check(
      'crm_pipelines_round_robin_cursor_nonnegative',
      sql`${t.roundRobinCursor} >= 0`,
    ),
    // The single-user target must be on the access list. The migration writes
    // ON DELETE SET NULL ("single_user_id"): only that column, not tenant/pipeline.
    foreignKey({
      name: 'crm_pipelines_single_user_fk',
      columns: [t.tenantId, t.id, t.singleUserId],
      foreignColumns: [
        crmPipelineUsers.tenantId,
        crmPipelineUsers.pipelineId,
        crmPipelineUsers.userId,
      ],
    }).onDelete('set null'),
    index('crm_pipelines_position_idx').on(t.position),
    // Target for tenant-safe foreign keys from stages and deals.
    uniqueIndex('crm_pipelines_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('crm_pipelines_tenant_name_key').on(
      t.tenantId,
      sql`lower(${t.name})`,
    ),
    check('crm_pipelines_name_not_blank', sql`length(btrim(${t.name})) > 0`),
    check('crm_pipelines_position_nonnegative', sql`${t.position} >= 0`),
    tenantIsolation(t.tenantId),
  ],
);

/** A column on the board; stages are unique per pipeline (case-insensitively). */
export const crmPipelineStages = pgTable.withRLS(
  'crm_pipeline_stages',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id').notNull(),
    name: text().notNull(),
    /** Column order; lower first. */
    position: integer().notNull().default(0),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('crm_pipeline_stages_pipeline_position_idx').on(
      t.pipelineId,
      t.position,
    ),
    uniqueIndex('crm_pipeline_stages_pipeline_name_key').on(
      t.pipelineId,
      sql`lower(${t.name})`,
    ),
    // A deal references its stage through (tenant, pipeline, stage), so a
    // stage from another pipeline or company is impossible.
    uniqueIndex('crm_pipeline_stages_tenant_pipeline_id_key').on(
      t.tenantId,
      t.pipelineId,
      t.id,
    ),
    foreignKey({
      name: 'crm_pipeline_stages_pipeline_fk',
      columns: [t.tenantId, t.pipelineId],
      foreignColumns: [crmPipelines.tenantId, crmPipelines.id],
    }).onDelete('cascade'),
    check(
      'crm_pipeline_stages_name_not_blank',
      sql`length(btrim(${t.name})) > 0`,
    ),
    check('crm_pipeline_stages_position_nonnegative', sql`${t.position} >= 0`),
    tenantIsolation(t.tenantId),
  ],
);

/**
 * A client's participation in one pipeline — the "CRM id". The client owns the
 * contact details; the deal only points at it. One client may appear in many
 * pipelines, but only once in any single pipeline.
 */
export const crmDeals = pgTable.withRLS(
  'crm_deals',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id').notNull(),
    stageId: uuid('stage_id').notNull(),
    clientId: uuid('client_id').notNull(),
    /** Order inside the stage; lower first. */
    position: integer().notNull().default(0),
    /** The deal's owner; null = unassigned. Must be on this pipeline's access list. */
    ownerId: uuid('owner_id'),
    /** How the current owner was assigned; meaningful only while `owner_id` is set. */
    assignmentSource: text('assignment_source').$type<CrmAssignmentRule>(),
    createdBy: uuid('created_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('crm_deals_stage_position_idx').on(t.stageId, t.position),
    index('crm_deals_pipeline_idx').on(t.pipelineId),
    index('crm_deals_client_id_idx').on(t.clientId),
    uniqueIndex('crm_deals_tenant_pipeline_client_key').on(
      t.tenantId,
      t.pipelineId,
      t.clientId,
    ),
    foreignKey({
      name: 'crm_deals_pipeline_fk',
      columns: [t.tenantId, t.pipelineId],
      foreignColumns: [crmPipelines.tenantId, crmPipelines.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'crm_deals_pipeline_stage_fk',
      columns: [t.tenantId, t.pipelineId, t.stageId],
      foreignColumns: [
        crmPipelineStages.tenantId,
        crmPipelineStages.pipelineId,
        crmPipelineStages.id,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'crm_deals_client_fk',
      columns: [t.tenantId, t.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('cascade'),
    check('crm_deals_position_nonnegative', sql`${t.position} >= 0`),
    check(
      'crm_deals_assignment_source',
      sql`${t.assignmentSource} is null or ${t.assignmentSource} in (${assignmentValues})`,
    ),
    // An owner must be on this pipeline's access list. The migration writes
    // ON DELETE SET NULL ("owner_id"): losing access unassigns, never fails.
    foreignKey({
      name: 'crm_deals_owner_fk',
      columns: [t.tenantId, t.pipelineId, t.ownerId],
      foreignColumns: [
        crmPipelineUsers.tenantId,
        crmPipelineUsers.pipelineId,
        crmPipelineUsers.userId,
      ],
    }).onDelete('set null'),
    index('crm_deals_pipeline_owner_idx').on(t.pipelineId, t.ownerId),
    // "Oldest unassigned first" for Share and Give.
    index('crm_deals_pipeline_unassigned_idx')
      .on(t.pipelineId, t.createdAt, t.id)
      .where(sql`${t.ownerId} is null`),
    tenantIsolation(t.tenantId),
  ],
);

/**
 * Pipeline access: who may see and work in a pipeline. Owners never have rows
 * (they see every pipeline); everyone else needs one, on top of the `crm` menu
 * grant. Deal assignment will later draw its candidates from this list.
 */
export const crmPipelineUsers = pgTable.withRLS(
  'crm_pipeline_users',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    pipelineId: uuid('pipeline_id').notNull(),
    userId: uuid('user_id').notNull(),
    grantedBy: uuid('granted_by').references((): AnyPgColumn => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  // Annotated: pipelines and their access list reference each other.
  (t): PgTableExtraConfigValue[] => [
    primaryKey({
      name: 'crm_pipeline_users_pkey',
      columns: [t.pipelineId, t.userId],
    }),
    // Target for tenant-safe foreign keys: a deal's owner and a pipeline's
    // single-user target must be on that pipeline's access list.
    uniqueIndex('crm_pipeline_users_tenant_pipeline_user_key').on(
      t.tenantId,
      t.pipelineId,
      t.userId,
    ),
    index('crm_pipeline_users_user_idx').on(t.userId),
    foreignKey({
      name: 'crm_pipeline_users_pipeline_fk',
      columns: [t.tenantId, t.pipelineId],
      foreignColumns: [crmPipelines.tenantId, crmPipelines.id],
    }).onDelete('cascade'),
    // The person must belong to the same company as the pipeline.
    foreignKey({
      name: 'crm_pipeline_users_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    tenantIsolation(t.tenantId),
  ],
);

export type CrmPipelineRow = typeof crmPipelines.$inferSelect;
export type CrmPipelineStageRow = typeof crmPipelineStages.$inferSelect;
export type CrmDealRow = typeof crmDeals.$inferSelect;

/* ── Reports ─────────────────────────────────────────────────────────────── */

export const reports = pgTable.withRLS(
  'reports',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    reportDate: date('report_date', { mode: 'string' }).notNull(),
    reportItems: jsonb('report_items').$type<string[]>().notNull().default([]),
    createdBy: uuid('created_by'),
    submittedAt: timestamptz('submitted_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    editedAt: timestamptz('edited_at'),
    attachmentType: text('attachment_type'),
    attachmentUrl: text('attachment_url'),
    /** An uploaded file: its key in the storage bucket, original name, size and stored type. */
    attachmentKey: text('attachment_key'),
    attachmentName: text('attachment_name'),
    attachmentSize: integer('attachment_size'),
    attachmentContentType: text('attachment_content_type'),
    remarks: text('remarks'),
  },
  (t) => [
    index('reports_tenant_id_idx').on(t.tenantId),
    index('reports_report_date_idx').on(t.reportDate),
    index('reports_created_by_idx').on(t.createdBy),
    index('reports_submitted_at_idx').on(t.submittedAt),
    // The migration writes ON DELETE SET NULL ("created_by"): deleting a person keeps their reports.
    foreignKey({
      name: 'reports_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('set null'),
    uniqueIndex('reports_tenant_created_by_date_key').on(
      t.tenantId,
      t.createdBy,
      t.reportDate,
    ),
    check('reports_items_array', sql`jsonb_typeof(${t.reportItems}) = 'array'`),
    check(
      'reports_attachment_type_valid',
      sql`${t.attachmentType} IS NULL OR ${t.attachmentType} IN ('url', 'file')`,
    ),
    // Exactly one shape: nothing, a link, or a stored file (never a mix).
    check(
      'reports_attachment_shape',
      sql`(
        (${t.attachmentType} IS NULL AND ${t.attachmentUrl} IS NULL AND ${t.attachmentKey} IS NULL)
        OR (${t.attachmentType} = 'url' AND ${t.attachmentUrl} IS NOT NULL AND ${t.attachmentKey} IS NULL)
        OR (${t.attachmentType} = 'file' AND ${t.attachmentUrl} IS NULL AND ${t.attachmentKey} IS NOT NULL
            AND ${t.attachmentName} IS NOT NULL AND ${t.attachmentSize} IS NOT NULL
            AND ${t.attachmentContentType} IS NOT NULL)
      )`,
    ),
    // One file belongs to one report.
    uniqueIndex('reports_attachment_key_key').on(t.attachmentKey),
    tenantIsolation(t.tenantId),
  ],
);

export const reportSettings = pgTable.withRLS(
  'report_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    /** IANA zone that "today", the due time and off days are read in. */
    timezone: text().notNull().default('Asia/Kolkata'),
    /** Reports submitted after this time on the day they cover are late; null = no due time. */
    dueTime: time('due_time'),
    skipDays: smallint('skip_days').array().notNull().default([]),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // The migration writes ON DELETE SET NULL ("updated_by").
    foreignKey({
      name: 'report_settings_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('set null'),
    tenantIsolation(t.tenantId),
  ],
);

export type ReportRow = typeof reports.$inferSelect;
export type ReportSettingsRow = typeof reportSettings.$inferSelect;

/* ── Calendar (docs/calendar-plan.md) ────────────────────────────────────── */

export const CALENDAR_EVENT_TYPES = ['announcement', 'meeting', 'task'] as const;

/** Stored task statuses (decision T1; `failed` and an ended hold are also derived on read, T8). */
export const TASK_STATUSES = [
  'assigned',
  'progress',
  'on_review',
  'on_hold',
  'request_cancelation',
  'cancelled',
  'failed',
  'completed',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPES)[number];

/**
 * Announcements and meetings. Stored status is only scheduled | cancelled;
 * upcoming / live / ended are derived from the time window when read.
 * Deleting is soft (deleted_at), so the activity log keeps its event.
 */
export const calendarEvents = pgTable.withRLS(
  'calendar_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    type: text().notNull().$type<CalendarEventType>(),
    title: text().notNull(),
    description: text(),
    /** Announcements and meetings: scheduled | cancelled. Tasks: a TaskStatus. */
    status: text()
      .notNull()
      .default('scheduled')
      .$type<'scheduled' | 'cancelled' | TaskStatus>(),
    startsAt: timestamptz('starts_at').notNull(),
    endsAt: timestamptz('ends_at').notNull(),
    /** Meeting only: a room, an address or a link. */
    location: text(),
    /** Meeting only: open (everyone) or private (creator and members). */
    visibility: text().$type<'open' | 'private'>(),
    cancelReason: text('cancel_reason'),
    /** Task only: who does it (ends_at is its deadline). Null once that person is deleted (T6). */
    assigneeId: uuid('assignee_id'),
    priority: text().$type<TaskPriority>(),
    /** Task workflow (T1): where a hold or a cancel request returns to. */
    previousStatus: text('previous_status').$type<TaskStatus>(),
    holdReason: text('hold_reason'),
    holdUntil: timestamptz('hold_until'),
    completionRemarks: text('completion_remarks'),
    /** Times the creator sent the work back: drives "Assigned (n)". */
    rejectCount: integer('reject_count').notNull().default(0),
    /** A pending request for more time (one at a time). */
    extensionUntil: timestamptz('extension_until'),
    extensionReason: text('extension_reason'),
    /** Optimistic concurrency: an edit names the version it read. */
    version: integer().notNull().default(1),
    createdBy: uuid('created_by'),
    deletedAt: timestamptz('deleted_at'),
    deletedBy: uuid('deleted_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('calendar_events_tenant_starts_idx').on(t.tenantId, t.startsAt),
    index('calendar_events_tenant_ends_idx').on(t.tenantId, t.endsAt),
    index('calendar_events_created_by_idx').on(t.createdBy),
    index('calendar_events_assignee_idx').on(t.tenantId, t.assigneeId),
    // Target for same-company foreign keys from members and the log.
    uniqueIndex('calendar_events_tenant_id_id_key').on(t.tenantId, t.id),
    // The migration writes ON DELETE SET NULL ("created_by") / ("deleted_by"): a deleted person's events stay.
    foreignKey({
      name: 'calendar_events_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'calendar_events_deleted_by_fk',
      columns: [t.tenantId, t.deletedBy],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('set null'),
    // ON DELETE SET NULL ("assignee_id"); a trigger first hands open tasks back to their creator (T6).
    foreignKey({
      name: 'calendar_events_assignee_fk',
      columns: [t.tenantId, t.assigneeId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('set null'),
    check(
      'calendar_events_type_valid',
      sql`${t.type} IN ('announcement', 'meeting', 'task')`,
    ),
    check(
      'calendar_events_status_valid',
      sql`(
        (${t.type} IN ('announcement', 'meeting') AND ${t.status} IN ('scheduled', 'cancelled'))
        OR (${t.type} = 'task' AND ${t.status} IN (
          'assigned', 'progress', 'on_review', 'on_hold', 'request_cancelation', 'cancelled', 'failed', 'completed'
        ))
      )`,
    ),
    check(
      'calendar_events_title_not_blank',
      sql`length(btrim(${t.title})) > 0`,
    ),
    check('calendar_events_time_order', sql`${t.endsAt} > ${t.startsAt}`),
    // Each type carries exactly its own fields.
    check(
      'calendar_events_type_shape',
      sql`(
        (${t.type} = 'announcement' AND ${t.description} IS NOT NULL
          AND ${t.location} IS NULL AND ${t.visibility} IS NULL AND ${t.priority} IS NULL)
        OR (${t.type} = 'meeting' AND ${t.location} IS NOT NULL
          AND ${t.visibility} IN ('open', 'private') AND ${t.priority} IS NULL)
        OR (${t.type} = 'task' AND ${t.location} IS NULL AND ${t.visibility} IS NULL
          AND ${t.priority} IN ('low', 'medium', 'high', 'urgent'))
      )`,
    ),
    // A hold always has an end; workflow fields belong to tasks only.
    check(
      'calendar_events_hold_shape',
      sql`(${t.status} <> 'on_hold' OR ${t.holdUntil} IS NOT NULL)`,
    ),
    check('calendar_events_reject_count', sql`${t.rejectCount} >= 0`),
    tenantIsolation(t.tenantId),
  ],
);

/** Who is invited to a meeting. The creator is implicitly a member. */
export const calendarMeetingMembers = pgTable.withRLS(
  'calendar_meeting_members',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    userId: uuid('user_id').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'calendar_meeting_members_pkey',
      columns: [t.tenantId, t.eventId, t.userId],
    }),
    index('calendar_meeting_members_user_idx').on(t.tenantId, t.userId),
    foreignKey({
      name: 'calendar_meeting_members_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [calendarEvents.tenantId, calendarEvents.id],
    }).onDelete('cascade'),
    // Deleting a person removes their invitations.
    foreignKey({
      name: 'calendar_meeting_members_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    tenantIsolation(t.tenantId),
  ],
);

/** Every change to an event: who, what, and the status move, for history later. */
export const calendarEventLog = pgTable.withRLS(
  'calendar_event_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references((): AnyPgColumn => tenants.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    actorId: uuid('actor_id'),
    action: text().notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    reason: text(),
    meta: jsonb(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('calendar_event_log_event_idx').on(
      t.tenantId,
      t.eventId,
      t.createdAt,
    ),
    foreignKey({
      name: 'calendar_event_log_event_fk',
      columns: [t.tenantId, t.eventId],
      foreignColumns: [calendarEvents.tenantId, calendarEvents.id],
    }).onDelete('cascade'),
    // The migration writes ON DELETE SET NULL ("actor_id").
    foreignKey({
      name: 'calendar_event_log_actor_fk',
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('set null'),
    tenantIsolation(t.tenantId),
  ],
);

export type CalendarEventRow = typeof calendarEvents.$inferSelect;
