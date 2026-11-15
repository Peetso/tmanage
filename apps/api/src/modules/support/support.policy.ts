import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { SUPPORT_CATEGORIES, SUPPORT_PRIORITIES } from './support-sla.js';
import type { SupportCategory, SupportPriority } from './support-sla.js';

/**
 * 55-17 — the pure rules of in-app support conversations. Kept free of I/O so the permission
 * rules are enumerated in a unit test rather than trusted.
 *
 * Who may see a thread, from inside an organization:
 * - the person who started it;
 * - an org admin (`org.manage`) — every thread of their own organization.
 * Nobody else in the organization, and never another organization's thread (every statement is
 * bound to the caller's organization). The platform team reads across organizations only through
 * the platform-admin routes (`platform.orgs.view` to read, `platform.orgs.edit` to reply).
 */

export const SUPPORT_STATUSES = ['open', 'waiting', 'closed'] as const;
export type SupportStatus = (typeof SUPPORT_STATUSES)[number];
export type SupportAuthorKind = 'member' | 'platform';

export const SUBJECT_MAX = 160;
export const BODY_MAX = 5000;
export const PATH_MAX = 300;
export const VERSION_MAX = 40;

/** Replies to the person come from this address (reply-to of the support e-mail). */
export const SUPPORT_REPLY_TO = 'tm-support@peetrix.com';

/** The platform permission that reads support threads, and the one that answers them. */
export const PLATFORM_SUPPORT_READ = 'platform.orgs.view';
export const PLATFORM_SUPPORT_REPLY = 'platform.orgs.edit';

export function isSupportStatus(value: unknown): value is SupportStatus {
  return typeof value === 'string' && (SUPPORT_STATUSES as readonly string[]).includes(value);
}

/** Org admins see every thread of their organization; everyone else only their own. */
export function seesWholeOrganization(context: Pick<TenantContext, 'capabilities'>): boolean {
  return context.capabilities.includes('org.manage');
}

export function maySeeThread(
  context: Pick<TenantContext, 'capabilities' | 'userId' | 'principalKind'>,
  thread: { readonly startedByUserId: string },
): boolean {
  if (context.principalKind !== 'internal') return false;
  if (thread.startedByUserId === context.userId) return true;
  return seesWholeOrganization(context);
}

/** Only the person who started a thread writes in it from the organization's side. */
export function mayWriteInThread(
  context: Pick<TenantContext, 'userId' | 'principalKind'>,
  thread: { readonly startedByUserId: string },
): boolean {
  return context.principalKind === 'internal' && thread.startedByUserId === context.userId;
}

/** The status a thread moves to when a message is added. A closed thread re-opens on a follow-up. */
export function statusAfterMessage(author: SupportAuthorKind): SupportStatus {
  return author === 'platform' ? 'waiting' : 'open';
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'Check the highlighted fields.', [
    { field, message },
  ]);
}

function requiredText(raw: unknown, field: string, max: number): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw invalid(field, 'required');
  if (value.length > max) throw invalid(field, `at most ${max} characters`);
  return value;
}

/** A page path the person was on: `/…`, no scheme, no host, no control characters. */
export function cleanContextPath(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw invalid('contextPath', 'must be a path');
  const value = raw.trim();
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.length > PATH_MAX ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f\s]/u.test(value)
  ) {
    throw invalid('contextPath', 'must be a path on this site');
  }
  return value;
}

export function cleanAppVersion(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^[\w.+-]{1,40}$/u.test(raw.trim())) {
    throw invalid('appVersion', 'must be a version');
  }
  return raw.trim();
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function cleanAttachmentId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !UUID_SHAPE.test(raw)) {
    throw invalid('attachmentFileId', 'must be an uploaded file');
  }
  return raw;
}

/** 57-10. Absent means the default; anything outside the list is a 400, never stored. */
function oneOf<T extends string>(
  raw: unknown,
  field: string,
  values: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'string' && (values as readonly string[]).includes(raw)) return raw as T;
  throw invalid(field, `must be one of ${values.join(', ')}`);
}

export interface NewThreadInput {
  readonly category: SupportCategory;
  readonly priority: SupportPriority;
  readonly subject: string;
  readonly body: string;
  readonly contextPath: string | null;
  readonly appVersion: string | null;
  readonly attachmentFileId: string | null;
}

export function parseNewThread(body: Readonly<Record<string, unknown>>): NewThreadInput {
  return {
    category: oneOf(body['category'], 'category', SUPPORT_CATEGORIES, 'question'),
    priority: oneOf(body['priority'], 'priority', SUPPORT_PRIORITIES, 'normal'),
    subject: requiredText(body['subject'], 'subject', SUBJECT_MAX),
    body: requiredText(body['message'], 'message', BODY_MAX),
    contextPath: cleanContextPath(body['contextPath']),
    appVersion: cleanAppVersion(body['appVersion']),
    attachmentFileId: cleanAttachmentId(body['attachmentFileId']),
  };
}

export interface NewMessageInput {
  readonly body: string;
  readonly attachmentFileId: string | null;
}

export function parseNewMessage(body: Readonly<Record<string, unknown>>): NewMessageInput {
  return {
    body: requiredText(body['message'], 'message', BODY_MAX),
    attachmentFileId: cleanAttachmentId(body['attachmentFileId']),
  };
}

export function parseStatus(raw: unknown): SupportStatus {
  if (!isSupportStatus(raw)) throw invalid('status', 'open, waiting or closed');
  return raw;
}
