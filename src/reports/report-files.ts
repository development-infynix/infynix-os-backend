import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { uploadToDisk, type UploadFileInfo } from '@nestjs/storage';
import type { AuthUser } from '../users/user.types.js';
import { FILES_DISK } from '../storage/storage.options.js';

/** The largest file a report can carry. */
export const MAX_REPORT_FILE_BYTES = 10 * 1024 * 1024;

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** PDF, images, Word, Excel, PowerPoint, CSV and plain text. */
export const REPORT_FILE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  DOCX,
  XLSX,
  PPTX,
  'application/msword',
  'application/vnd.ms-excel',
  'text/csv',
  'text/plain',
];

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/**
 * Types the built-in detection can't see (it knows images and PDF). The
 * bytes decide the family (a ZIP container, an old Office file, or text with
 * no binary bytes) and the extension only picks within it, so a renamed
 * executable is still refused.
 */
function detectOfficeOrText(
  bytes: Buffer,
  file: UploadFileInfo,
): string | undefined {
  const ext =
    file.originalname.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (bytes.subarray(0, 4).equals(ZIP)) {
    return { docx: DOCX, xlsx: XLSX, pptx: PPTX }[ext];
  }
  if (bytes.subarray(0, 8).equals(OLE)) {
    return { doc: 'application/msword', xls: 'application/vnd.ms-excel' }[ext];
  }
  if (!bytes.includes(0)) {
    return { csv: 'text/csv; charset=utf-8', txt: 'text/plain; charset=utf-8' }[
      ext
    ];
  }
  return undefined;
}

/** The folder a person's report files live in. */
export const reportFilesPrefix = (tenantId: string, userId: string) =>
  `tenants/${tenantId}/reports/${userId}/`;

/**
 * Streams an upload straight into the bucket at a random key under the
 * uploader's own folder; the client's file name never becomes part of a key.
 */
export const reportFileStorage = uploadToDisk({
  disk: FILES_DISK,
  contentTypes: REPORT_FILE_TYPES,
  detectContentType: detectOfficeOrText,
  key: (file, req: { user?: AuthUser }) => {
    const user = req.user;
    if (!user) throw new UnauthorizedException();
    const ext =
      file.extension ||
      (file.originalname.toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] ?? '');
    return `${reportFilesPrefix(user.tenantId, user.id)}${randomUUID()}${ext}`;
  },
});

/** A display name from the client's file name: no folders or control characters, at most 200 characters. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // UTF-16 units are fine here: only control characters (all single units) are dropped.
  const cleaned = base
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(-200);
  return cleaned || 'file';
}
