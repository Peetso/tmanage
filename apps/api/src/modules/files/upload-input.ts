import { isContentHash } from '@tmanage/domain';
import { UPLOAD_PURPOSES } from '../../common/database/schema.js';
import type { UploadPurpose } from '../../common/database/schema.js';

/**
 * Body and header parsing shared by FILE-001's two doors — the studio's `/upload-sessions`
 * and the client's `/portal/upload-sessions` — for `client-request-input.ts`'s reason: one
 * shape, two paths, and a limit with two answers is a limit with none.
 *
 * Widths are the columns' (`0015_file_uploads.sql`) and the contract's
 * (`openapi.yaml` `CreateUploadSessionRequest`); where they disagree the narrower wins and
 * the wider is the recorded ceiling.
 */

/** `upload_sessions.declared_name` is `VARCHAR(255)`; the contract says 1..255. */
export const MAX_FILE_NAME_LENGTH = 255;
/** `declared_mime_type` is `VARCHAR(150)`; the contract says up to 150. */
export const MAX_MIME_TYPE_LENGTH = 150;
/** The contract's absolute ceiling (5 GiB). `UPLOAD_MAX_BYTES` is the effective one. */
export const CONTRACT_MAX_SIZE_BYTES = 5_368_709_120;
/**
 * The caller's `Idempotency-Key`. Bounded and shaped so it can be a column value and an
 * audit value: letters, digits, `_` and `-`, 16 to 128 characters. Shorter than 16 is a
 * key that two unrelated uploads could plausibly share.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
/**
 * A MIME type is `type/subtype` with optional parameters. The shape only — the value is the
 * caller's declaration and FILE-002's detection is what the system trusts.
 */
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;.*)?$/i;

export interface ValidationDetail {
  field: string;
  message: string;
}

export interface ParsedUploadBody {
  readonly projectId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly contentHash: string | null;
  readonly purpose: UploadPurpose;
  readonly objectId: string | null;
  /** Internal door only. `'client_visible'` or the default `'internal'`. */
  readonly audience: 'internal' | 'client_visible';
}

export function isUploadPurpose(value: string): value is UploadPurpose {
  return (UPLOAD_PURPOSES as readonly string[]).includes(value);
}

/** The header, required. Absent or off-pattern is a 400 naming the header as the field. */
export function requiredIdempotencyKey(
  raw: unknown,
  details: ValidationDetail[],
): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    details.push({
      field: 'Idempotency-Key',
      message: 'header is required: 16 to 128 letters, digits, _ or -',
    });
    return undefined;
  }
  return value;
}

/**
 * Parse `CreateUploadSessionRequest`, plus the `projectId` the contract lacks (recorded
 * divergence: `49` §6 step 2 authorizes "the project/object" before reserving, and there is
 * no other way to know which project). `maxSizeBytes` is the effective single-upload
 * ceiling — refused here, before any database touch, as a plain field error.
 */
export function parseUploadBody(
  body: unknown,
  maxSizeBytes: number,
  details: ValidationDetail[],
): ParsedUploadBody | undefined {
  const input = (body ?? {}) as Record<string, unknown>;

  const projectId = typeof input['projectId'] === 'string' ? input['projectId'] : '';
  if (projectId === '') details.push({ field: 'projectId', message: 'is required' });

  const fileName = typeof input['fileName'] === 'string' ? input['fileName'].trim() : '';
  if (fileName.length < 1 || fileName.length > MAX_FILE_NAME_LENGTH) {
    details.push({ field: 'fileName', message: `must be 1 to ${MAX_FILE_NAME_LENGTH} characters` });
  } else if (fileName.includes('/') || fileName.includes('\\') || fileName.includes('\0')) {
    // A name is a label, never a path. The object key is built from identifiers, so this
    // cannot traverse anything — but a name that looks like a path is a name a screen will
    // render wrongly, and refusing it here is cheaper than every renderer defending.
    details.push({ field: 'fileName', message: 'must not contain a path separator' });
  }

  const mimeType = typeof input['mimeType'] === 'string' ? input['mimeType'].trim() : '';
  if (
    mimeType.length < 1 ||
    mimeType.length > MAX_MIME_TYPE_LENGTH ||
    !MIME_TYPE_PATTERN.test(mimeType)
  ) {
    details.push({ field: 'mimeType', message: 'must be a media type such as image/png' });
  }

  const sizeBytes = input['sizeBytes'];
  const effectiveMax = Math.min(maxSizeBytes, CONTRACT_MAX_SIZE_BYTES);
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    details.push({ field: 'sizeBytes', message: 'must be a positive integer' });
  } else if (sizeBytes > effectiveMax) {
    details.push({
      field: 'sizeBytes',
      message: `exceeds the largest single upload of ${effectiveMax} bytes`,
    });
  }

  let contentHash: string | null = null;
  if (input['contentHash'] !== undefined && input['contentHash'] !== null) {
    if (typeof input['contentHash'] !== 'string' || !isContentHash(input['contentHash'])) {
      details.push({ field: 'contentHash', message: 'must be a lowercase hex SHA-256 digest' });
    } else {
      contentHash = input['contentHash'];
    }
  }

  const purposeRaw = typeof input['purpose'] === 'string' ? input['purpose'] : '';
  if (!isUploadPurpose(purposeRaw)) {
    details.push({ field: 'purpose', message: `must be one of ${UPLOAD_PURPOSES.join(', ')}` });
  }

  let objectId: string | null = null;
  if (input['objectId'] !== undefined && input['objectId'] !== null) {
    if (typeof input['objectId'] !== 'string' || input['objectId'] === '') {
      details.push({ field: 'objectId', message: 'must be an id' });
    } else {
      objectId = input['objectId'];
    }
  }

  let audience: 'internal' | 'client_visible' = 'internal';
  if (input['audience'] !== undefined) {
    if (input['audience'] === 'internal' || input['audience'] === 'client_visible') {
      audience = input['audience'];
    } else {
      details.push({ field: 'audience', message: 'must be internal or client_visible' });
    }
  }

  if (details.length > 0 || !isUploadPurpose(purposeRaw) || typeof sizeBytes !== 'number') {
    return undefined;
  }
  return {
    projectId,
    fileName,
    mimeType,
    sizeBytes,
    contentHash,
    purpose: purposeRaw,
    objectId,
    audience,
  };
}

export interface ParsedPart {
  readonly partNumber: number;
  readonly etag: string;
}

/** `CompleteUploadRequest.parts`: at least one, each a positive part number and an etag. */
export function parseParts(body: unknown, details: ValidationDetail[]): readonly ParsedPart[] {
  const input = (body ?? {}) as Record<string, unknown>;
  const raw = input['parts'];
  if (!Array.isArray(raw) || raw.length === 0) {
    details.push({ field: 'parts', message: 'must be a non-empty array' });
    return [];
  }
  const parts: ParsedPart[] = [];
  raw.forEach((candidate, index) => {
    const part = (candidate ?? {}) as Record<string, unknown>;
    const partNumber = part['partNumber'];
    const etag = part['etag'];
    if (typeof partNumber !== 'number' || !Number.isSafeInteger(partNumber) || partNumber < 1) {
      details.push({ field: `parts[${index}].partNumber`, message: 'must be a positive integer' });
    }
    if (typeof etag !== 'string' || etag.length < 1 || etag.length > 255) {
      details.push({ field: `parts[${index}].etag`, message: 'must be 1 to 255 characters' });
    }
    if (typeof partNumber === 'number' && typeof etag === 'string') {
      parts.push({ partNumber, etag });
    }
  });
  return parts;
}
