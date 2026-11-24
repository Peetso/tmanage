import { uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import {
  MailRecipientSuppressedError,
  anchored,
  designedPlainMail,
  workspaceReplyLine,
  workspaceSignOff,
} from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import type { ExternalApproverRow, PublicLinkRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { PublicLinkDecisionDetail } from '../public-links/public-link-targets.js';
import type { PublicLinksService, PublicLinkView } from '../public-links/public-links.service.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import type { DeliverablesRepository } from './deliverables.repository.js';
import type { ExternalApproversRepository } from './external-approvers.repository.js';

/**
 * 52-18 — the account-less approver. A member with `deliverable.publish` on the project sends one
 * deliverable version to an outside e-mail; the approver opens `/a/<token>`, asks for the 6-digit
 * code mailed to that address, and approves or requests changes with a comment.
 *
 * The secret side is the 56-07 link system, unchanged in kind: an `approval` link on the
 * `deliverable_version` target, ALWAYS bound to the e-mail and ALWAYS needing the code (hashed
 * token, expiry ≤ 30 days, one terminal decision, per-IP and per-link limits, the link's own
 * service context). This service adds the approval record (0320): who was asked, by whom, for
 * which content hash, and the decision — written once by the link's decision transaction through
 * {@link ExternalApprovalsService.recordDecision}, which also appends `approval.decided.v1` (the
 * worker tells the sender and the deliverable makers) and an `approval.*` audit row.
 */

export const EXTERNAL_DECISIONS = ['approve', 'request_changes'] as const;
export type ExternalDecision = (typeof EXTERNAL_DECISIONS)[number];
export const MAX_OPEN_PER_VERSION = 20;
export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_EXPIRY_DAYS = 30;
const MAX_EMAIL = 320;
const MAX_NAME = 120;
const MAX_MESSAGE = 1_000;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface SendExternalApprovalInput {
  readonly email: string;
  readonly name: string | null;
  readonly message: string | null;
  readonly expiresInDays: number;
  readonly language: 'en' | 'ar';
}

export interface ExternalApproverView {
  readonly id: string;
  readonly linkId: string;
  readonly email: string;
  readonly name: string | null;
  readonly message: string | null;
  readonly language: string;
  readonly requestedByUserId: string;
  readonly requestedAt: string;
  /** The link's state: active | opened | decided | expired | revoked (`unknown` if not listed). */
  readonly linkStatus: string;
  readonly expiresAt: string | null;
  readonly decision: string | null;
  readonly comment: string | null;
  readonly typedName: string | null;
  readonly emailVerified: boolean;
  readonly decidedAt: string | null;
}

export interface SentExternalApproval {
  readonly approver: ExternalApproverView;
  /** The approver's page, shown once so the sender can also share it by hand. */
  readonly url: string;
  readonly mailed: boolean;
}

export interface ExternalApprovalsServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly approvers: Pick<
    ExternalApproversRepository,
    'insert' | 'findByLink' | 'listForVersion' | 'decide'
  >;
  readonly versions: Pick<DeliverableVersionsRepository, 'findById'>;
  readonly deliverables: Pick<DeliverablesRepository, 'findById'>;
  readonly links: Pick<PublicLinksService, 'createInTransaction' | 'list'>;
  readonly outbox: Pick<OutboxEventsRepository, 'append'> | null;
  readonly audit: Pick<AuditService, 'record'> | null;
  readonly mailer: Mailer | null;
  readonly organizationName: (tx: TenantQueryRunner, context: TenantContext) => Promise<string>;
  readonly webPublicUrl: string;
  readonly now?: () => Date;
}

export class ExternalApprovalsService {
  private readonly now: () => Date;

  constructor(private readonly options: ExternalApprovalsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async send(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
    versionId: string,
    body: unknown,
  ): Promise<SentExternalApproval> {
    const input = validateSend(body);
    requireUuid(deliverableId);
    requireUuid(versionId);
    const staged = await this.options.database.transaction(context, async (tx) => {
      const version = await this.options.versions.findById(tx, context, versionId);
      if (version === null || version.deliverableId !== deliverableId) throw notFound();
      const open = (await this.options.approvers.listForVersion(tx, context, versionId)).filter(
        (row) => row.decision === null,
      );
      if (open.length >= MAX_OPEN_PER_VERSION) {
        throw new ApiError(429, 'rate_limited', 'This version already has too many open requests.');
      }
      // The link service authorizes `deliverable.publish` on the version's project (404 if not).
      const link = await this.options.links.createInTransaction(tx, context, principal, {
        kind: 'approval',
        targetType: 'deliverable_version',
        targetId: versionId,
        audienceEmail: input.email,
        requireCode: true,
        language: input.language,
        expiresInDays: input.expiresInDays,
        maxUses: null,
      });
      const at = this.now();
      const row: ExternalApproverRow = {
        id: uuidv7(),
        organizationId: context.organizationId,
        publicLinkId: link.id,
        projectId: version.projectId,
        deliverableId,
        deliverableVersionId: versionId,
        contentHash: version.contentHash,
        email: input.email,
        displayName: input.name,
        message: input.message,
        language: input.language,
        requestedByUserId: context.userId,
        requestedAt: at,
        decision: null,
        decisionComment: null,
        typedName: null,
        emailVerified: false,
        decidedAt: null,
        decidedIpHash: null,
        decidedUserAgent: null,
      };
      await this.options.approvers.insert(tx, context, row);
      const deliverable = await this.options.deliverables.findById(tx, context, deliverableId);
      const organizationName = await this.options.organizationName(tx, context);
      return {
        row,
        link,
        title: deliverable?.title ?? '',
        versionNo: version.versionNo,
        organizationName,
      };
    });
    const url = approverUrl(this.options.webPublicUrl, staged.link.token);
    let mailed = false;
    // A relative link (no WEB_PUBLIC_URL) is never mailed: the sender copies it instead.
    if (this.options.mailer !== null && /^https?:\/\//u.test(url)) {
      try {
        await this.options.mailer.send({
          to: input.email,
          ...approvalMail({
            url,
            organizationName: staged.organizationName,
            title: staged.title,
            versionNo: staged.versionNo,
            message: input.message,
            expiresAt: staged.link.expiresAt,
            language: input.language,
          }),
          organizationId: context.organizationId,
          templateKey: 'external_approval',
          audience: 'client',
          actingFor: { workspaceName: staged.organizationName, replyRoute: 'none' },
        });
        mailed = true;
      } catch (error) {
        // 56-26: the address bounced in this company — not mailed; the sender copies the link.
        if (!(error instanceof MailRecipientSuppressedError)) throw error;
      }
    }
    return { approver: toView(staged.row, staged.link), url, mailed };
  }

  async list(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
    versionId: string,
  ): Promise<readonly ExternalApproverView[]> {
    requireUuid(deliverableId);
    requireUuid(versionId);
    // Authorizes `deliverable.publish` on the version's project; another tenant's version is 404.
    const links = await this.options.links.list(context, principal, {
      targetType: 'deliverable_version',
      targetId: versionId,
    });
    const rows = await this.options.database.read(context, async (r) => {
      const version = await this.options.versions.findById(r, context, versionId);
      if (version === null || version.deliverableId !== deliverableId) throw notFound();
      return this.options.approvers.listForVersion(r, context, versionId);
    });
    const byId = new Map(links.map((link) => [link.id, link]));
    return rows.map((row) => toView(row, byId.get(row.publicLinkId) ?? null));
  }

  /**
   * The link's decision observer for `deliverable_version`: runs inside the outsider's decision
   * transaction under the link's service context. A link issued by the generic route (no record)
   * is left alone; a refusal throws, which rolls the link's decision back too.
   */
  async recordDecision(
    tx: TenantQueryRunner,
    context: TenantContext,
    link: PublicLinkRow,
    decision: string,
    detail: PublicLinkDecisionDetail,
  ): Promise<void> {
    const record = await this.options.approvers.findByLink(tx, context, link.id);
    if (record === null) return;
    const refusal = externalDecisionRefusal(record, link, decision, detail);
    if (refusal !== null) {
      throw new ApiError(409, 'conflict', 'This approval can no longer be recorded.', [
        { field: 'decision', message: refusal },
      ]);
    }
    const recorded = await this.options.approvers.decide(tx, context, record.id, {
      decision,
      comment: detail.comment,
      typedName: detail.typedName,
      emailVerified: detail.verified,
      decidedAt: detail.decidedAt,
      ipHash: detail.ipHash,
      userAgent: detail.userAgent,
    });
    if (!recorded) {
      throw new ApiError(409, 'conflict', 'This approval can no longer be recorded.');
    }
    const outcome = decision === 'approve' ? 'approved' : 'changes_requested';
    await this.options.outbox?.append(tx, context, {
      type: 'approval.decided.v1',
      aggregateId: record.id,
      payload: {
        approvalId: record.id,
        deliverableId: record.deliverableId,
        deliverableVersionId: record.deliverableVersionId,
        projectId: record.projectId,
        decision: outcome,
        // Not a user: the planner skips only the decider, so the sender is always told.
        decidedByUserId: record.id,
        requestedByUserId: record.requestedByUserId,
      },
    });
    await this.options.audit?.record(tx, context, {
      action: outcome === 'approved' ? 'approval.approved' : 'approval.changes_requested',
      objectId: record.id,
      result: 'allowed',
      actorUserId: null,
      metadata: {
        via: 'external_approver',
        public_link_id: link.id,
        deliverable_id: record.deliverableId,
        deliverable_version_id: record.deliverableVersionId,
        project_id: record.projectId,
        email_verified: detail.verified ? 'true' : 'false',
      },
    });
  }
}

/**
 * The decision permission, as one pure check: `null` = the outsider may record this decision.
 * The link system has already matched the token, the expiry, the live state and the version hash
 * it was shown; this re-checks what the approval record itself demands.
 */
export function externalDecisionRefusal(
  record: Pick<
    ExternalApproverRow,
    'decision' | 'contentHash' | 'deliverableVersionId' | 'publicLinkId' | 'organizationId'
  >,
  link: Pick<PublicLinkRow, 'id' | 'kind' | 'targetId' | 'versionHash' | 'organizationId'>,
  decision: string,
  detail: Pick<PublicLinkDecisionDetail, 'verified'>,
): string | null {
  if (record.organizationId !== link.organizationId || record.publicLinkId !== link.id) {
    return 'not_this_link';
  }
  if (link.kind !== 'approval' || record.deliverableVersionId !== link.targetId) {
    return 'not_this_link';
  }
  if (record.decision !== null) return 'already_decided';
  if (link.versionHash !== record.contentHash) return 'superseded';
  if (!EXTERNAL_DECISIONS.some((d) => d === decision)) return 'unknown_decision';
  if (!detail.verified) return 'unverified';
  return null;
}

export function approverUrl(webPublicUrl: string, token: string): string {
  return `${webPublicUrl.replace(/\/+$/u, '')}/a/${encodeURIComponent(token)}`;
}

/** EMAIL-COPY K10 in the language the sender chose for the approver. */
export function approvalMail(facts: {
  readonly url: string;
  readonly organizationName: string;
  readonly title: string;
  readonly versionNo: number | null;
  readonly message: string | null;
  readonly expiresAt: string;
  readonly language: 'en' | 'ar';
}): {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly language: 'en' | 'ar';
} {
  const version = facts.versionNo === null ? '' : ` (v${facts.versionNo})`;
  const day = facts.expiresAt.slice(0, 10);
  const studio = facts.organizationName;
  const note = facts.message === null ? '' : `"${facts.message}"`;
  const language = facts.language;
  const ar = language === 'ar';
  // EMAIL-COPY K10, one language per mail, signed [WS] with R3 (the link is the way to answer).
  const lines = ar
    ? [
        `يطلب ${studio} مراجعتك واعتمادك لـ "${facts.title}"${version}.`,
        note,
        { label: 'افتح وقرّر', link: facts.url },
        `لا تحتاج إلى حساب. سنرسل إليك رمزًا من 6 أرقام لتأكيد هويتك. يعمل الرابط حتى ${day}.`,
      ]
    : [
        `${studio} asks you to review and approve "${facts.title}"${version}.`,
        note,
        { label: 'Open and decide', link: facts.url },
        `You do not need an account. We will e-mail you a 6-digit code to confirm it is you. The link works until ${day}.`,
      ];
  const subject = anchored(
    language,
    ar
      ? `${studio}: من فضلك راجع ${facts.title}${version}`
      : `${studio}: please review ${facts.title}${version}`,
  );
  return {
    language,
    subject,
    ...designedPlainMail(language, {
      subject,
      eyebrow: studio,
      lines,
      signature: workspaceSignOff(
        language,
        studio,
        workspaceReplyLine(language, 'none', { workspaceName: studio, portalLink: facts.url }),
      ),
    }),
  };
}

export function validateSend(raw: unknown): SendExternalApprovalInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  if (email.length > MAX_EMAIL || !EMAIL_SHAPE.test(email)) {
    throw invalid('email', 'must be an e-mail address');
  }
  const name = optionalText(body['name'], 'name', MAX_NAME);
  const message = optionalText(body['message'], 'message', MAX_MESSAGE);
  const days = body['expiresInDays'] ?? DEFAULT_EXPIRY_DAYS;
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > MAX_EXPIRY_DAYS) {
    throw invalid('expiresInDays', `must be a whole number from 1 to ${MAX_EXPIRY_DAYS}`);
  }
  const language = body['language'] ?? 'en';
  if (language !== 'en' && language !== 'ar') throw invalid('language', 'must be en or ar');
  return { email, name, message, expiresInDays: days as number, language };
}

function toView(row: ExternalApproverRow, link: PublicLinkView | null): ExternalApproverView {
  return {
    id: row.id,
    linkId: row.publicLinkId,
    email: row.email,
    name: row.displayName,
    message: row.message,
    language: row.language,
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.requestedAt.toISOString(),
    linkStatus: link?.status ?? 'unknown',
    expiresAt: link?.expiresAt ?? null,
    decision: row.decision,
    comment: row.decisionComment,
    typedName: row.typedName,
    emailVerified: row.emailVerified,
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw invalid(field, 'must be a string');
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(field, `must be at most ${max} characters`);
  return trimmed === '' ? null : trimmed;
}

function requireUuid(id: string): void {
  if (!UUID_SHAPE.test(id)) throw notFound();
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function notFound(): ApiError {
  return new ApiError(
    404,
    'not_found',
    MESSAGES.notFound,
    undefined,
    'external_approval.not_visible',
  );
}
