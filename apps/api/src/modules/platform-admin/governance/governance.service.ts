import { uuidv7 } from '@tmanage/domain';
import { greeting } from '@tmanage/mail';
import type { Mailer } from '@tmanage/mail';
import { ApiError, MESSAGES } from '../../../common/http/errors.js';
import { optionalReason, requireReason } from '../platform-admin.access.js';
import type { PlatformRequestContext } from '../platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { platformAuditFor } from '../platform-audit.service.js';
import type {
  ApprovalRecord,
  GovernanceStore,
  OwnerNoticeRecord,
} from './governance.repository.js';

/**
 * 56-21 (R46 L2) — platform governance: the two-person rule for risky platform actions, and
 * notices to a company owner.
 *
 * **Two-person rule.** While the policy is on (`two_person_approval` = `on`, off by default), a
 * risky action (`RISKY_PLATFORM_ACTIONS`) runs only with the id of an approval that:
 * - names the same action and the same target,
 * - was asked for by the admin now running it,
 * - was approved by a DIFFERENT admin (the service refuses a self-approval with a 403, and the
 *   SQL refuses it again),
 * - is not expired (24 hours) and not used before — using it marks it `used` in the same statement,
 *   so one approval runs one action.
 *
 * **Owner notices.** A platform admin writes a subject and a message to one company's owner. The
 * owner's address is read at send time (never stored), the mail goes through the server's mailer
 * (the 56-31 queue when configured), and the row plus a `platform.owner_notice_sent` audit entry
 * record it. Without a mailer the notice is stored with delivery `none`.
 */

export const RISKY_PLATFORM_ACTIONS = [
  'company.suspend',
  'company.delete',
  'company.transfer_ownership',
] as const;
export type RiskyPlatformAction = (typeof RISKY_PLATFORM_ACTIONS)[number];

export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const NOTICE_SEVERITIES = ['info', 'warning', 'critical'] as const;
const SUBJECT_MAX = 190;
const BODY_MAX = 5000;
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isRiskyPlatformAction(value: unknown): value is RiskyPlatformAction {
  return typeof value === 'string' && (RISKY_PLATFORM_ACTIONS as readonly string[]).includes(value);
}

export interface ApprovalView {
  readonly id: string;
  readonly action: string;
  readonly targetId: string;
  readonly targetLabel: string | null;
  readonly reason: string;
  readonly status: ApprovalRecord['status'];
  readonly requestedByEmail: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedByEmail: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  /** The caller asked for it (so they may not approve it, and may use it once approved). */
  readonly mine: boolean;
}

export interface ApprovalsView {
  readonly policy: { readonly enabled: boolean };
  readonly actions: readonly string[];
  readonly approvals: readonly ApprovalView[];
}

export interface OwnerNoticeView {
  readonly id: string;
  readonly organizationId: string;
  readonly subject: string;
  readonly severity: string;
  readonly delivery: string;
  readonly sentByEmail: string | null;
  readonly createdAt: string;
}

type Body = Readonly<Record<string, unknown>>;

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function requireUuid(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !ID_SHAPE.test(raw)) throw invalid(field, 'must be an id');
  return raw.toLowerCase();
}

function notFound(code: string): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, code);
}

export function approvalRequired(action: RiskyPlatformAction): ApiError {
  return new ApiError(
    409,
    'conflict',
    'This action needs a second platform admin to approve it first.',
    [{ field: 'approvalId', message: action }],
    'platform_approval_required',
  );
}

/** What an approval looks like at `now`: a pending or approved row past its expiry is expired. */
export function effectiveStatus(row: ApprovalRecord, now: Date): ApprovalRecord['status'] {
  if ((row.status === 'pending' || row.status === 'approved') && row.expiresAt <= now) {
    return 'expired';
  }
  return row.status;
}

function toView(row: ApprovalRecord, actorId: string, now: Date): ApprovalView {
  return {
    id: row.id,
    action: row.action,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    reason: row.reason,
    status: effectiveStatus(row, now),
    requestedByEmail: row.requestedByEmail,
    requestedAt: row.requestedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedByEmail: row.decidedByEmail,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
    mine: row.requestedBy === actorId,
  };
}

function noticeView(row: OwnerNoticeRecord): OwnerNoticeView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    subject: row.subject,
    severity: row.severity,
    delivery: row.delivery,
    sentByEmail: row.sentByEmail,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PlatformGovernanceService {
  constructor(
    private readonly store: GovernanceStore,
    private readonly mailer: Mailer | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Two-person rule ─────────────────────────────────────────────────────

  async approvals(
    actor: PlatformAdminActor,
    context: PlatformRequestContext,
  ): Promise<ApprovalsView> {
    const [enabled, rows] = await Promise.all([
      this.store.readPolicy(context.correlationId),
      this.store.listApprovals(context.correlationId),
    ]);
    const now = this.now();
    return {
      policy: { enabled },
      actions: [...RISKY_PLATFORM_ACTIONS],
      approvals: rows.map((row) => toView(row, actor.account.userId, now)),
    };
  }

  async setPolicy(
    actor: PlatformAdminActor,
    body: Body,
    context: PlatformRequestContext,
  ): Promise<{ readonly enabled: boolean }> {
    if (typeof body['enabled'] !== 'boolean') throw invalid('enabled', 'must be true or false');
    const enabled = body['enabled'];
    const reason = requireReason(body['reason']);
    await this.store.writePolicy(
      enabled,
      platformAuditFor(actor, context, {
        action: 'platform.two_person_policy_changed',
        targetType: 'setting',
        targetId: null,
        targetLabel: 'two_person_approval',
        reason,
        afterJson: JSON.stringify({ enabled }),
      }),
    );
    return { enabled };
  }

  async request(
    actor: PlatformAdminActor,
    body: Body,
    context: PlatformRequestContext,
  ): Promise<ApprovalView> {
    const action = body['action'];
    if (!isRiskyPlatformAction(action)) {
      throw invalid('action', `must be one of ${RISKY_PLATFORM_ACTIONS.join(', ')}`);
    }
    const targetId = requireUuid(body['targetId'], 'targetId');
    const rawLabel = body['targetLabel'];
    if (rawLabel !== undefined && rawLabel !== null && typeof rawLabel !== 'string') {
      throw invalid('targetLabel', 'must be text');
    }
    const targetLabel =
      typeof rawLabel === 'string' && rawLabel.trim() !== '' ? rawLabel.trim().slice(0, 190) : null;
    const reason = requireReason(body['reason']);
    const now = this.now();
    const id = uuidv7();
    const row = {
      id,
      action,
      targetId,
      targetLabel,
      reason,
      requestedBy: actor.account.userId,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
    };
    await this.store.insertApproval(
      row,
      platformAuditFor(actor, context, {
        action: 'platform.approval_requested',
        targetType: 'organization',
        targetId,
        targetLabel,
        reason,
        organizationId: targetId,
        afterJson: JSON.stringify({ approvalId: id, action }),
      }),
    );
    return toView(
      {
        ...row,
        status: 'pending',
        requestedByEmail: actor.account.email,
        decidedBy: null,
        decidedByEmail: null,
        decidedAt: null,
        decisionNote: null,
        usedAt: null,
      },
      actor.account.userId,
      now,
    );
  }

  /** A different admin approves or rejects a pending, unexpired request. */
  async decide(
    actor: PlatformAdminActor,
    rawId: unknown,
    decision: 'approved' | 'rejected',
    body: Body,
    context: PlatformRequestContext,
  ): Promise<ApprovalView> {
    const id = requireUuid(rawId, 'id');
    const existing = await this.store.findApproval(id, context.correlationId);
    if (!existing) throw notFound('platform_approval_not_found');
    if (existing.requestedBy === actor.account.userId) {
      throw new ApiError(
        403,
        'forbidden',
        'Another platform admin must decide on your own request.',
        undefined,
        'platform_approval_self',
      );
    }
    const now = this.now();
    if (effectiveStatus(existing, now) !== 'pending') {
      throw new ApiError(
        409,
        'conflict',
        'This request was already decided or has expired.',
        undefined,
        'platform_approval_closed',
      );
    }
    const note = optionalReason(body['note'] ?? body['reason']);
    const done = await this.store.decide(
      id,
      decision,
      actor.account.userId,
      note,
      now,
      platformAuditFor(actor, context, {
        action:
          decision === 'approved' ? 'platform.approval_approved' : 'platform.approval_rejected',
        targetType: 'organization',
        targetId: existing.targetId,
        targetLabel: existing.targetLabel,
        reason: note,
        organizationId: existing.targetId,
        afterJson: JSON.stringify({ approvalId: id, action: existing.action }),
      }),
    );
    if (!done) {
      throw new ApiError(
        409,
        'conflict',
        'This request was already decided or has expired.',
        undefined,
        'platform_approval_closed',
      );
    }
    return toView(
      {
        ...existing,
        status: decision,
        decidedBy: actor.account.userId,
        decidedByEmail: actor.account.email,
        decidedAt: now,
        decisionNote: note,
      },
      actor.account.userId,
      now,
    );
  }

  /**
   * The gate a risky route runs before acting. Policy off → nothing to do. Policy on → the
   * approval must exist and is consumed here (one approval, one action).
   */
  async requireApproval(
    actor: PlatformAdminActor,
    action: RiskyPlatformAction,
    targetId: string,
    rawApprovalId: unknown,
    context: PlatformRequestContext,
  ): Promise<void> {
    if (!(await this.store.readPolicy(context.correlationId))) return;
    if (typeof rawApprovalId !== 'string' || !ID_SHAPE.test(rawApprovalId)) {
      throw approvalRequired(action);
    }
    const id = rawApprovalId.toLowerCase();
    const used = await this.store.consume(
      id,
      action,
      targetId,
      actor.account.userId,
      this.now(),
      platformAuditFor(actor, context, {
        action: 'platform.approval_used',
        targetType: 'organization',
        targetId,
        targetLabel: null,
        reason: null,
        organizationId: targetId,
        afterJson: JSON.stringify({ approvalId: id, action }),
      }),
    );
    if (!used) throw approvalRequired(action);
  }

  // ── Owner notices ───────────────────────────────────────────────────────

  async notices(
    query: Readonly<Record<string, unknown>>,
    context: PlatformRequestContext,
  ): Promise<{ readonly notices: readonly OwnerNoticeView[] }> {
    const raw = query['organizationId'];
    const organizationId =
      raw === undefined || raw === null || raw === '' ? null : requireUuid(raw, 'organizationId');
    const rows = await this.store.listNotices(organizationId, context.correlationId);
    return { notices: rows.map(noticeView) };
  }

  async sendNotice(
    actor: PlatformAdminActor,
    body: Body,
    context: PlatformRequestContext,
  ): Promise<OwnerNoticeView> {
    const organizationId = requireUuid(body['organizationId'], 'organizationId');
    const subject = typeof body['subject'] === 'string' ? body['subject'].trim() : '';
    if (subject === '' || subject.length > SUBJECT_MAX || /[\r\n]/u.test(subject)) {
      throw invalid('subject', `required, one line, at most ${String(SUBJECT_MAX)} characters`);
    }
    const message = typeof body['body'] === 'string' ? body['body'].trim() : '';
    if (message === '' || message.length > BODY_MAX) {
      throw invalid('body', `required, at most ${String(BODY_MAX)} characters`);
    }
    const severity = body['severity'] ?? 'info';
    if (
      typeof severity !== 'string' ||
      !(NOTICE_SEVERITIES as readonly string[]).includes(severity)
    ) {
      throw invalid('severity', `must be one of ${NOTICE_SEVERITIES.join(', ')}`);
    }
    const owner = await this.store.findOwner(organizationId, context.correlationId);
    if (!owner) throw notFound('platform_org_not_found');
    if (owner.ownerUserId === null || owner.ownerEmail === null) {
      throw new ApiError(
        409,
        'conflict',
        'This company has no active owner to send to.',
        undefined,
        'platform_owner_missing',
      );
    }

    let delivery = 'none';
    if (this.mailer !== null) {
      try {
        // EMAIL-COPY C3: a human wrote it, so no "sent automatically" line; the staff name is
        // the signed-in account's, never typed in the form. The owner row carries no name or
        // language, so the greeting is "Hello," and the mail is English.
        const staff = actor.account.displayName.trim();
        delivery = await this.mailer.send({
          to: owner.ownerEmail,
          language: 'en',
          subject: `About ${owner.organizationName}: ${subject}`,
          text: [
            greeting('en', undefined),
            message,
            'If you have a question about this, reply to this e-mail. It reaches our support team.',
            staff === '' ? 'TManage Support' : `${staff}, TManage Support`,
          ].join('\n\n'),
          templateKey: 'platform_owner_notice',
        });
      } catch {
        delivery = 'failed';
      }
    }
    const now = this.now();
    const id = uuidv7();
    await this.store.insertNotice(
      {
        id,
        organizationId,
        ownerUserId: owner.ownerUserId,
        subject,
        body: message,
        severity,
        delivery,
        sentBy: actor.account.userId,
        createdAt: now,
      },
      platformAuditFor(actor, context, {
        action: 'platform.owner_notice_sent',
        targetType: 'organization',
        targetId: organizationId,
        targetLabel: owner.organizationName,
        reason: null,
        organizationId,
        afterJson: JSON.stringify({ noticeId: id, severity, delivery }),
      }),
    );
    return {
      id,
      organizationId,
      subject,
      severity,
      delivery,
      sentByEmail: actor.account.email,
      createdAt: now.toISOString(),
    };
  }
}
