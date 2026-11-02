import { randomBytes } from 'node:crypto';
import { ApiError } from '../../../common/http/errors.js';
import { toCsv } from '@tmanage/domain';
import type {
  PlatformExportJobView,
  PlatformExportScope,
  PlatformExportStatus,
  PlatformSignInView,
} from './activity.service.js';

/**
 * C6 exports (platform-admin v2 · PA-09) — the pure rules: which scopes exist, which filter keys
 * each scope accepts, the row cap, the 24-hour life of a file, the object key, and the sign-ins
 * CSV the API writes itself.
 *
 * Every scope but `sign-ins` is written by the worker (`apps/worker/src/jobs/export-jobs.ts`).
 * Sign-ins come from `authentication_events`, the security log the relay credential may never
 * read (`least-privilege.db.test.ts`), so the API — which already reads it for C3 — writes that
 * file at request time.
 */

export const EXPORT_SCOPES = [
  'actions',
  'sign-ins',
  'sessions',
  'platform',
  'orgs',
  'people',
] as const;

/** The filter keys each scope carries into the job (anything else is dropped). */
export const EXPORT_FILTER_KEYS: Readonly<Record<PlatformExportScope, readonly string[]>> = {
  actions: [
    'organizationId',
    'actorUserId',
    'effectiveActorUserId',
    'supportOnly',
    'supportSessionId',
    'action',
    'actionFamily',
    'objectType',
    'objectId',
    'result',
    'from',
    'to',
    'ip',
    'correlationId',
  ],
  'sign-ins': ['userId', 'email', 'outcome', 'reason', 'ip', 'from', 'to'],
  sessions: ['userId', 'active', 'ip'],
  platform: ['adminId', 'action', 'organizationId', 'from', 'to'],
  orgs: ['q'],
  people: ['q'],
};

/** The most rows one file holds. A bigger filter fails with a message to narrow it. */
export const EXPORT_ROW_CAP = 50_000;
/** A ready file can be downloaded this long, then the worker removes it. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000;
/** The newest jobs C6 lists. */
export const EXPORT_LIST_LIMIT = 100;

const MAX_FILTER_VALUE = 200;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the export and try again.', [
    { field, message },
  ]);
}

export function requireScope(raw: unknown): PlatformExportScope {
  if (typeof raw === 'string' && (EXPORT_SCOPES as readonly string[]).includes(raw)) {
    return raw as PlatformExportScope;
  }
  throw invalid('scope', EXPORT_SCOPES.join(', '));
}

/** Keep only the scope's keys, as short strings; booleans become `'true'`. */
export function normalizeFilter(
  scope: PlatformExportScope,
  raw: unknown,
): Readonly<Record<string, string>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('filter', 'an object');
  const out: Record<string, string> = {};
  for (const key of EXPORT_FILTER_KEYS[scope]) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === '' || value === false) continue;
    const textValue = value === true ? 'true' : typeof value === 'string' ? value.trim() : null;
    if (textValue === null) throw invalid(`filter.${key}`, 'text');
    if (textValue.length > MAX_FILTER_VALUE) {
      throw invalid(`filter.${key}`, `at most ${MAX_FILTER_VALUE} characters`);
    }
    if (textValue !== '') out[key] = textValue;
  }
  return out;
}

/** `platform/exports/<jobId>/<random>.csv` — the random part keeps a key unguessable. */
export function exportObjectKey(jobId: string): string {
  return `platform/exports/${jobId}/${randomBytes(16).toString('hex')}.csv`;
}

export function exportExpiry(finishedAt: Date): Date {
  return new Date(finishedAt.getTime() + EXPORT_TTL_MS);
}

/** The row's stored status as the screen sees it: a ready file past its expiry is `expired`. */
export function viewStatus(
  stored: string,
  expiresAt: Date | null,
  now: Date,
): PlatformExportStatus {
  if (stored === 'ready' && expiresAt !== null && expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (
    stored === 'queued' ||
    stored === 'running' ||
    stored === 'ready' ||
    stored === 'failed' ||
    stored === 'expired'
  ) {
    return stored;
  }
  return 'expired';
}

export function exportFileName(job: Pick<PlatformExportJobView, 'scope' | 'createdAt'>): string {
  return `tmanage-${job.scope}-${job.createdAt.slice(0, 10)}.csv`;
}

export function parseFilterJson(raw: string | null): Readonly<Record<string, string>> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export const SIGN_IN_CSV_HEADER = [
  'occurredAt',
  'email',
  'action',
  'outcome',
  'reason',
  'ip',
  'device',
  'correlationId',
] as const;

/** The sign-ins file, with the action log export's escaping (formula guard, RFC 4180 quoting). */
export function signInsToCsv(rows: readonly PlatformSignInView[]): string {
  return toCsv(
    rows.map((row) => [
      row.occurredAt,
      row.email,
      row.action,
      row.outcome,
      row.reason,
      row.ip,
      row.userAgent,
      row.correlationId,
    ]),
    SIGN_IN_CSV_HEADER,
  );
}
