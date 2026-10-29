import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { optionalReason, requireId } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import { ANNOUNCEMENT_AUDIENCES, ANNOUNCEMENT_SEVERITIES } from './announcements.repository.js';
import type {
  AnnouncementAudience,
  AnnouncementInput,
  AnnouncementRecord,
  AnnouncementSeverity,
  PlatformAnnouncementsRepository,
} from './announcements.repository.js';

/**
 * Platform admin · D3 Announcements (SPEC §4 D3, §5.6, §6 0244) and the public banner read.
 *
 * An announcement is written in English (required) and Arabic (optional — the English text shows
 * when there is none), with a severity, an optional link and window, an audience (everyone, chosen
 * organizations, or client portals) and whether people can close it. Drafts are visible only
 * here; Publish puts it live inside its window. Delete unpublishes and archives (no hard delete).
 */

export const MAX_TITLE = 190;
export const MAX_BODY = 2000;
export const MAX_LINK = 2048;
export const MAX_AUDIENCE_ORGS = 500;

export type AnnouncementStatus = 'draft' | 'scheduled' | 'live' | 'expired';

export interface PlatformAnnouncementView {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string | null;
  readonly bodyEn: string;
  readonly bodyAr: string | null;
  readonly severity: AnnouncementSeverity;
  readonly linkUrl: string | null;
  readonly audience: AnnouncementAudience;
  readonly audienceOrganizationIds: readonly string[];
  readonly dismissible: boolean;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly published: boolean;
  readonly status: AnnouncementStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatformAnnouncementsView {
  readonly announcements: readonly PlatformAnnouncementView[];
}

/** `GET /public/site/announcements` — the banner for one locale, already in that language. */
export interface PublicAnnouncementView {
  readonly id: string;
  readonly locale: 'en' | 'ar';
  readonly title: string;
  readonly body: string;
  readonly severity: AnnouncementSeverity;
  readonly linkUrl: string | null;
  readonly dismissible: boolean;
  readonly endsAt: string | null;
}

export interface PublicAnnouncementsView {
  readonly announcement: PublicAnnouncementView | null;
  readonly asOf: string;
}

/** Where the banner is being shown. */
export interface AnnouncementViewer {
  readonly surface: 'app' | 'portal' | 'site';
  readonly organizationId: string | null;
}

type Body = Readonly<Record<string, unknown>>;

export function announcementStatus(record: AnnouncementRecord, now: Date): AnnouncementStatus {
  if (record.endsAt && record.endsAt.getTime() <= now.getTime()) return 'expired';
  if (!record.published) return 'draft';
  if (record.startsAt && record.startsAt.getTime() > now.getTime()) return 'scheduled';
  return 'live';
}

export function toAnnouncementView(
  record: AnnouncementRecord,
  now: Date,
): PlatformAnnouncementView {
  return {
    id: record.id,
    titleEn: record.titleEn,
    titleAr: record.titleAr,
    bodyEn: record.bodyEn,
    bodyAr: record.bodyAr,
    severity: record.severity,
    linkUrl: record.linkUrl,
    audience: record.audience,
    audienceOrganizationIds: record.audienceOrganizationIds,
    dismissible: record.dismissible,
    startsAt: record.startsAt?.toISOString() ?? null,
    endsAt: record.endsAt?.toISOString() ?? null,
    published: record.published,
    status: announcementStatus(record, now),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Whether a live announcement is for this viewer. Pure. */
export function announcementReaches(
  record: Pick<AnnouncementRecord, 'audience' | 'audienceOrganizationIds'>,
  viewer: AnnouncementViewer,
): boolean {
  if (record.audience === 'everyone') return true;
  if (record.audience === 'clients') return viewer.surface === 'portal';
  return (
    viewer.surface === 'app' &&
    viewer.organizationId !== null &&
    record.audienceOrganizationIds.includes(viewer.organizationId)
  );
}

const SEVERITY_RANK: Record<AnnouncementSeverity, number> = { critical: 3, warning: 2, info: 1 };

/** The one banner to show: the most severe live announcement for the viewer, newest first. */
export function pickPublicAnnouncement(
  live: readonly AnnouncementRecord[],
  viewer: AnnouncementViewer,
  locale: 'en' | 'ar',
  now: Date,
): PublicAnnouncementView | null {
  const candidates = live
    .filter((record) => announcementStatus(record, now) === 'live')
    .filter((record) => announcementReaches(record, viewer))
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
  const head = candidates[0];
  if (!head) return null;
  const arabic = locale === 'ar' && head.titleAr !== null && head.titleAr !== '';
  return {
    id: head.id,
    locale: arabic ? 'ar' : 'en',
    title: arabic ? (head.titleAr ?? head.titleEn) : head.titleEn,
    body: arabic ? (head.bodyAr ?? head.bodyEn) : head.bodyEn,
    severity: head.severity,
    linkUrl: head.linkUrl,
    dismissible: head.dismissible,
    endsAt: head.endsAt?.toISOString() ?? null,
  };
}

function field(message: string, name: string, detail: string): ApiError {
  return new ApiError(400, 'validation_failed', message, [{ field: name, message: detail }]);
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) {
    throw field('Fill in the English text.', name, `required, 1–${max} characters`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw field('The text is too long.', name, `at most ${max} characters`);
  }
  return value.trim() === '' ? null : value.trim();
}

function instant(value: unknown, name: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw field('The date is invalid.', name, 'ISO-8601 instant');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw field('The date is invalid.', name, 'ISO-8601 instant');
  return parsed;
}

function link(value: unknown): string | null {
  const raw = optionalText(value, 'linkUrl', MAX_LINK);
  if (raw === null) return null;
  const withScheme = /^https?:\/\//iu.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
    return url.toString();
  } catch {
    throw field('The link is not a web address.', 'linkUrl', 'an http(s) address');
  }
}

/** The editable fields from a POST/PATCH body (PATCH merges over `base`). Pure. */
export function parseAnnouncementBody(body: Body, base?: AnnouncementInput): AnnouncementInput {
  const has = (key: string) => body?.[key] !== undefined;
  const severity = has('severity') ? body['severity'] : (base?.severity ?? 'info');
  if (!(ANNOUNCEMENT_SEVERITIES as readonly unknown[]).includes(severity)) {
    throw field('Choose a severity.', 'severity', ANNOUNCEMENT_SEVERITIES.join(', '));
  }
  const audience = has('audience') ? body['audience'] : (base?.audience ?? 'everyone');
  if (!(ANNOUNCEMENT_AUDIENCES as readonly unknown[]).includes(audience)) {
    throw field('Choose who sees it.', 'audience', ANNOUNCEMENT_AUDIENCES.join(', '));
  }
  let organizations = base?.audienceOrganizationIds ?? [];
  if (has('audienceOrganizationIds')) {
    const raw = body['audienceOrganizationIds'];
    if (!Array.isArray(raw) || raw.length > MAX_AUDIENCE_ORGS) {
      throw field('Choose the organizations.', 'audienceOrganizationIds', 'a list of ids');
    }
    organizations = [
      ...new Set(
        raw.map((id: unknown) => {
          try {
            return requireId(id);
          } catch {
            throw field('Choose the organizations.', 'audienceOrganizationIds', 'a list of ids');
          }
        }),
      ),
    ];
  }
  if (audience === 'organizations' && organizations.length === 0) {
    throw field('Choose at least one organization.', 'audienceOrganizationIds', 'required');
  }
  const dismissible = has('dismissible') ? body['dismissible'] : (base?.dismissible ?? true);
  if (typeof dismissible !== 'boolean') {
    throw field('Choose whether people can close it.', 'dismissible', 'must be a boolean');
  }
  const startsAt = has('startsAt')
    ? instant(body['startsAt'], 'startsAt')
    : (base?.startsAt ?? null);
  const endsAt = has('endsAt') ? instant(body['endsAt'], 'endsAt') : (base?.endsAt ?? null);
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    throw field('The end must be after the start.', 'endsAt', 'after startsAt');
  }
  return {
    titleEn: has('titleEn')
      ? requiredText(body['titleEn'], 'titleEn', MAX_TITLE)
      : requiredText(base?.titleEn, 'titleEn', MAX_TITLE),
    titleAr: has('titleAr')
      ? optionalText(body['titleAr'], 'titleAr', MAX_TITLE)
      : (base?.titleAr ?? null),
    bodyEn: has('bodyEn')
      ? requiredText(body['bodyEn'], 'bodyEn', MAX_BODY)
      : requiredText(base?.bodyEn, 'bodyEn', MAX_BODY),
    bodyAr: has('bodyAr')
      ? optionalText(body['bodyAr'], 'bodyAr', MAX_BODY)
      : (base?.bodyAr ?? null),
    severity: severity as AnnouncementSeverity,
    linkUrl: has('linkUrl') ? link(body['linkUrl']) : (base?.linkUrl ?? null),
    audience: audience as AnnouncementAudience,
    audienceOrganizationIds: audience === 'organizations' ? organizations : [],
    dismissible,
    startsAt,
    endsAt,
  };
}

function auditShape(input: AnnouncementInput) {
  return {
    titleEn: input.titleEn,
    titleAr: input.titleAr,
    severity: input.severity,
    audience: input.audience,
    organizations: input.audienceOrganizationIds.length,
    dismissible: input.dismissible,
    startsAt: input.startsAt?.toISOString() ?? null,
    endsAt: input.endsAt?.toISOString() ?? null,
  };
}

export class PlatformAnnouncementsService {
  constructor(private readonly repository: PlatformAnnouncementsRepository) {}

  async list(context: RequestContext): Promise<PlatformAnnouncementsView> {
    const now = new Date();
    const rows = await this.repository.list(context.correlationId);
    return { announcements: rows.map((row) => toAnnouncementView(row, now)) };
  }

  async create(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformAnnouncementView> {
    const input = parseAnnouncementBody(body);
    const publish = body?.['published'] === true;
    const reason = optionalReason(body?.['reason']);
    const id = await this.repository.create(input, publish, actor.account.userId, (newId) =>
      platformAuditFor(actor, context, {
        action: publish ? 'platform.announcement_published' : 'platform.announcement_created',
        targetType: 'platform',
        targetId: newId,
        targetLabel: input.titleEn.slice(0, 190),
        reason,
        beforeJson: null,
        afterJson: JSON.stringify({ ...auditShape(input), published: publish }),
      }),
    );
    return this.view(id, context);
  }

  async update(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformAnnouncementView> {
    const id = requireId(rawId);
    const existing = await this.repository.find(id, context.correlationId);
    if (!existing || existing.archived) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const input = parseAnnouncementBody(body, existing);
    const reason = optionalReason(body?.['reason']);
    const found = await this.repository.update(
      id,
      input,
      platformAuditFor(actor, context, {
        action: 'platform.announcement_updated',
        targetType: 'platform',
        targetId: id,
        targetLabel: input.titleEn.slice(0, 190),
        reason,
        beforeJson: JSON.stringify(auditShape(existing)),
        afterJson: JSON.stringify(auditShape(input)),
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.view(id, context);
  }

  async setPublished(
    actor: PlatformAdminActor,
    rawId: string,
    published: boolean,
    body: Body,
    context: RequestContext,
  ): Promise<PlatformAnnouncementView> {
    const id = requireId(rawId);
    const reason = optionalReason(body?.['reason']);
    const found = await this.repository.setPublished(
      id,
      published,
      platformAuditFor(actor, context, {
        action: published ? 'platform.announcement_published' : 'platform.announcement_unpublished',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason,
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.view(id, context);
  }

  /** Delete = unpublish + archive. No hard delete. */
  async archive(
    actor: PlatformAdminActor,
    rawId: string,
    body: Body,
    context: RequestContext,
  ): Promise<{ readonly archived: true }> {
    const id = requireId(rawId);
    const reason = optionalReason(body?.['reason']);
    const found = await this.repository.archive(
      id,
      platformAuditFor(actor, context, {
        action: 'platform.announcement_archived',
        targetType: 'platform',
        targetId: id,
        targetLabel: null,
        reason,
      }),
    );
    if (!found) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return { archived: true };
  }

  private async view(id: string, context: RequestContext): Promise<PlatformAnnouncementView> {
    const record = await this.repository.find(id, context.correlationId);
    if (!record) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return toAnnouncementView(record, new Date());
  }
}
