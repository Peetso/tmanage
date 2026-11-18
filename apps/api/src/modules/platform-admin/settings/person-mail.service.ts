import { uuidv7 } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';
import { requireId } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import type { RequestContext } from '../platform-admin.service.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type {
  FeatureNewsInput,
  FeatureNewsRecord,
  PersonMailRepository,
} from './person-mail.repository.js';

/**
 * EMAILBUILD2 — the platform side of the person-mail engine (amendment 2):
 *
 * - the "Tips and reminders" switch (`platform_settings` `mail.tips_enabled`, absent = off): off
 *   stops every person mail, the after-new-device security follow-up included;
 * - the "Feature news" card: a platform admin writes a release note (title and up to two
 *   sentences, English and Arabic, one link) and presses Send once. From then on the worker's
 *   hourly sweep delivers it to every team member with tips on, once each, for 14 days.
 *
 * Platform admins only (the controller's guard and `platform.settings.edit`). Every write is
 * audited. Text is checked here and again by the worker (one line, no control characters).
 */

type Body = Readonly<Record<string, unknown>>;

export const NEWS_TITLE_MAX = 120;
export const NEWS_BODY_MAX = 400;
export const NEWS_LINK_MAX = 500;

export interface FeatureNewsView {
  readonly id: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly bodyEn: string;
  readonly bodyAr: string;
  readonly link: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
}

export interface PersonMailStateView {
  readonly tipsEnabled: boolean;
  readonly news: readonly FeatureNewsView[];
}

const invalid = (field: string, detail: string): ApiError =>
  new ApiError(400, 'validation_failed', 'The request is invalid', [{ field, message: detail }]);

/** Any C0/C1 control character or a line/paragraph separator: a note is plain text on one line. */
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

function text(raw: unknown, field: string, max: number): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '' || value.length > max || hasControl(value)) {
    throw invalid(field, `text, 1-${String(max)} characters, one line`);
  }
  return value;
}

/**
 * The note's one link: an in-app path (`/work`, opened in the member's own workspace) or an
 * https address (a release page). ASCII only, no protocol-relative `//`, no backslash.
 */
function link(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const ascii = /^[!-~]+$/u.test(value) && !value.includes('\\');
  const path = /^\/(?!\/)[A-Za-z0-9\-._~/?#=&%]*$/u.test(value);
  let https = false;
  if (!path && value.startsWith('https://')) {
    try {
      https = new URL(value).protocol === 'https:';
    } catch {
      https = false;
    }
  }
  if (value.length > NEWS_LINK_MAX || !ascii || (!path && !https)) {
    throw invalid('link', 'an in-app path starting with / or an https:// address');
  }
  return value;
}

/** A note from a body. Pure; every refusal is a 400 with nothing written. */
export function parseFeatureNews(body: Body): FeatureNewsInput {
  return {
    titleEn: text(body['titleEn'], 'titleEn', NEWS_TITLE_MAX),
    titleAr: text(body['titleAr'], 'titleAr', NEWS_TITLE_MAX),
    bodyEn: text(body['bodyEn'], 'bodyEn', NEWS_BODY_MAX),
    bodyAr: text(body['bodyAr'], 'bodyAr', NEWS_BODY_MAX),
    link: link(body['link']),
  };
}

function view(record: FeatureNewsRecord): FeatureNewsView {
  return {
    id: record.id,
    titleEn: record.titleEn,
    titleAr: record.titleAr,
    bodyEn: record.bodyEn,
    bodyAr: record.bodyAr,
    link: record.link,
    createdAt: record.createdAt.toISOString(),
    sentAt: record.sentAt === null ? null : record.sentAt.toISOString(),
  };
}

export class PersonMailService {
  constructor(private readonly repository: PersonMailRepository) {}

  async state(context: RequestContext): Promise<PersonMailStateView> {
    const { tipsEnabled, news } = await this.repository.state(context.correlationId);
    return { tipsEnabled, news: news.map(view) };
  }

  async setSwitch(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PersonMailStateView> {
    const enabled = body?.['enabled'];
    if (typeof enabled !== 'boolean') throw invalid('enabled', 'must be a boolean');
    const before = await this.repository.state(context.correlationId);
    await this.repository.writeSwitch(
      enabled,
      platformAuditFor(actor, context, {
        action: enabled ? 'platform.person_mail_switched_on' : 'platform.person_mail_switched_off',
        targetType: 'setting',
        targetId: null,
        targetLabel: 'mail.tips_enabled',
        reason: null,
        beforeJson: JSON.stringify({ tipsEnabled: before.tipsEnabled }),
        afterJson: JSON.stringify({ tipsEnabled: enabled }),
      }),
    );
    return this.state(context);
  }

  async createNews(
    actor: PlatformAdminActor,
    body: Body,
    context: RequestContext,
  ): Promise<PersonMailStateView> {
    const input = parseFeatureNews(body ?? {});
    const id = uuidv7();
    await this.repository.insert(
      id,
      input,
      actor.account.userId,
      platformAuditFor(actor, context, {
        action: 'platform.feature_news_added',
        targetType: 'setting',
        targetId: null,
        targetLabel: input.titleEn,
        reason: null,
        beforeJson: null,
        afterJson: JSON.stringify({ id, ...input }),
      }),
    );
    return this.state(context);
  }

  /** Send once: a second press is a 409 and changes nothing. */
  async sendNews(
    actor: PlatformAdminActor,
    rawId: string,
    context: RequestContext,
  ): Promise<PersonMailStateView> {
    const id = requireId(rawId);
    const note = await this.repository.byId(id, context.correlationId);
    if (note === null) throw new ApiError(404, 'not_found', 'That note is not in the list.');
    const alreadySent = () => new ApiError(409, 'conflict', 'This note was already sent.');
    if (note.sentAt !== null) throw alreadySent();
    const sent = await this.repository.send(
      id,
      actor.account.userId,
      platformAuditFor(actor, context, {
        action: 'platform.feature_news_sent',
        targetType: 'setting',
        targetId: null,
        targetLabel: note.titleEn,
        reason: null,
        beforeJson: null,
        afterJson: JSON.stringify({ id }),
      }),
    );
    if (!sent) throw alreadySent();
    return this.state(context);
  }
}
