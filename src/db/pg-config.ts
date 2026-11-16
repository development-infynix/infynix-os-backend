import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolConfig } from 'pg';

export interface PgConfigOptions {
  /**
   * Use DATABASE_URL_UNPOOLED (a direct connection, bypassing a pgbouncer
   * pooler such as Neon's) when it is set. Migrations and the seed need it.
   */
  unpooled?: boolean;
}

/**
 * Builds the node-postgres pool config from DATABASE_URL.
 *
 * The SSL query parameters are handled here instead of being left to pg:
 * - `sslmode=require` / `prefer`: TLS, verifying the server certificate
 *   against the system CAs (fine for Neon and other public-CA providers).
 * - `sslmode=verify-ca` / `verify-full`: verify against the CA file in
 *   `sslrootcert` (or DATABASE_SSL_CA), path relative to the backend folder.
 * - `channel_binding=require`: SCRAM-SHA-256-PLUS (pg's enableChannelBinding).
 */
export function pgPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
  { unpooled = false }: PgConfigOptions = {},
): PoolConfig {
  const raw = (unpooled && env.DATABASE_URL_UNPOOLED) || env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');

  const url = new URL(raw);
  const sslmode = url.searchParams.get('sslmode') ?? 'disable';
  const rootCert = url.searchParams.get('sslrootcert') ?? env.DATABASE_SSL_CA;
  const channelBinding = url.searchParams.get('channel_binding');
  for (const param of ['sslmode', 'sslrootcert', 'channel_binding']) {
    url.searchParams.delete(param);
  }

  let ssl: PoolConfig['ssl'] = false;
  if (sslmode === 'verify-full' || sslmode === 'verify-ca') {
    if (!rootCert) {
      throw new Error(
        `sslmode=${sslmode} needs a CA certificate (sslrootcert in DATABASE_URL, or DATABASE_SSL_CA)`,
      );
    }
    const caPath = resolve(rootCert);
    let ca: string;
    try {
      ca = readFileSync(caPath, 'utf8');
    } catch {
      throw new Error(
        `Database CA certificate not found at ${caPath}. Download it from your database provider and place it there (or point DATABASE_SSL_CA at it).`,
      );
    }
    ssl = {
      ca,
      rejectUnauthorized: true,
      // verify-ca checks the chain but not the hostname.
      ...(sslmode === 'verify-ca' && { checkServerIdentity: () => undefined }),
    };
  } else if (sslmode === 'require' || sslmode === 'prefer') {
    ssl = { rejectUnauthorized: true };
  }

  return {
    connectionString: url.toString(),
    ssl,
    enableChannelBinding: channelBinding === 'require',
    max: Number(env.DATABASE_POOL_MAX ?? 10),
  };
}
