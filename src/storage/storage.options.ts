import type { ConfigService } from '@nestjs/config';
import { S3Disk, type StorageModuleOptions } from '@nestjs/storage';

/** The disk uploaded files live on. Keys start with `tenants/<company id>/`. */
export const FILES_DISK = 'files';

/**
 * One S3-compatible disk (Neon Object Storage in development and production).
 * Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, read by
 * the disk itself; the endpoint, region and bucket are configured here.
 */
export function storageOptions(config: ConfigService): StorageModuleOptions {
  return {
    default: FILES_DISK,
    disks: {
      [FILES_DISK]: new S3Disk({
        bucket: config.getOrThrow<string>('S3_BUCKET'),
        endpoint: config.getOrThrow<string>('AWS_ENDPOINT_URL_S3'),
        region: config.get<string>('AWS_REGION', 'eu-central-1'),
        forcePathStyle: true,
        timeout: 30_000,
      }),
    },
  };
}
