import type { Principal } from '@tmanage/domain';
import {
  anchored,
  forCompany,
  greeting,
  workspaceReplyLine,
  workspaceSignOff,
} from '@tmanage/mail';
import type { Mailer, MailMessage } from '@tmanage/mail';
import { ObjectNotFoundError } from '@tmanage/storage';
import type { ObjectStore } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import type { InboundEmailRepository } from './inbound-email.repository.js';
import { requireCapability } from './inbound-email.service.js';
import type { InboundAttachmentsRepository } from './inbound-attachments.repository.js';
import { PREVIEW_TYPES } from './inbound-attachment-scan.js';
import { INBOUND_DOMAIN, attachmentObjectKey, senderAddress } from './inbound-mail-rules.js';

/**
 * R22-d (54-12a part 2) — serving a clean inbound attachment, and asking a sender to re-send.
 *
 * - Preview (`client_request.triage`): only a `clean` row whose detected type is an image or a
 *   PDF (rule 4); anything else — `scanning`, `waiting_trust`, a clean DOCX — is the same 404
 *   `not_available`, so the route never says why.
 * - Download (`file.download`, internal audience): only a `clean` row (rule 3); `attachment`
 *   disposition; one `inbound_email.attachment_downloaded` audit row (`source: inbound_email`) is
 *   written before the first byte, failing closed.
 * - Ask-resend (`client_request.triage`): the mail must hold at least one `blocked_type`,
 *   `too_large` or `unavailable` attachment (else 409 `nothing_to_resend`); one ask per mail per
 *   24 h, read from the audit log under a row lock on the mail (else 429). No column records the
 *   ask: the `inbound_email.ask_resend` audit row is the record (stated). The reply is plain text,
 *   English then Arabic, names the attachments and carries no link.
 *
 * A client principal is refused everywhere (`requireCapability`).
 */

/** The states a sender can fix by sending again. */
export const RESEND_STATES: ReadonlySet<string> = new Set([
  'blocked_type',
  'too_large',
  'unavailable',
]);
export const ASK_RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;
export const ASK_RESEND_TEMPLATE = 'inbound_ask_resend';
const MAX_NAMES = 5;

export interface ServedAttachment {
  readonly stream: NodeJS.ReadableStream;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly fileName: string;
}

export interface AskResendResult {
  readonly id: string;
  readonly attachments: number;
  readonly delivery: 'sent' | 'none' | 'failed';
}

export class InboundAttachmentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly attachments: InboundAttachmentsRepository,
    private readonly mails: InboundEmailRepository,
    private readonly store: ObjectStore | null,
    private readonly audit: AuditService,
    private readonly mailer: Mailer | null,
    private readonly auditEvents: AuditEventsRepository = new AuditEventsRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<ServedAttachment> {
    requireCapability(principal, context, 'client_request.triage');
    const row = await this.database.read(context, (runner) =>
      this.attachments.findForServe(runner, context, id),
    );
    if (
      row === null ||
      row.state !== 'clean' ||
      row.detectedType === null ||
      !PREVIEW_TYPES.has(row.detectedType)
    ) {
      throw notAvailable();
    }
    return this.open(context, row, row.detectedType);
  }

  async download(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<ServedAttachment> {
    requireCapability(principal, context, 'file.download');
    const row = await this.database.read(context, (runner) =>
      this.attachments.findForServe(runner, context, id),
    );
    if (row === null || row.state !== 'clean') throw notAvailable();
    const served = await this.open(context, row, row.detectedType ?? 'application/octet-stream');
    try {
      await this.audit.recordStandalone(context, {
        action: 'inbound_email.attachment_downloaded',
        objectId: row.id,
        result: 'allowed',
        metadata: { source: 'inbound_email', size_bytes: row.sizeBytes },
      });
    } catch (error) {
      destroy(served.stream);
      throw error;
    }
    return served;
  }

  async askResend(
    context: TenantContext,
    principal: Principal,
    mailId: string,
  ): Promise<AskResendResult> {
    requireCapability(principal, context, 'client_request.triage');
    const at = this.now();
    const plan = await this.database.transaction(context, async (tx) => {
      const mail = await this.mails.findEmail(tx, context, mailId, true);
      if (!mail) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'inbound_email_not_found',
        );
      }
      const rows = await this.mails.listAttachments(tx, context, [mailId]);
      const resendable = rows.filter((row) => RESEND_STATES.has(row.state));
      const to = senderAddress(mail.fromEmail);
      if (resendable.length === 0 || to === null) {
        throw new ApiError(
          409,
          'conflict',
          'This e-mail has no attachment the sender can re-send',
          undefined,
          'nothing_to_resend',
        );
      }
      const last = await this.auditEvents.list(tx, context, {
        action: 'inbound_email.ask_resend',
        objectId: mailId,
        limit: 1,
      });
      const previous = last[0]?.createdAt;
      if (previous !== undefined && previous.getTime() > at.getTime() - ASK_RESEND_WINDOW_MS) {
        throw new ApiError(
          429,
          'rate_limited',
          'The sender was already asked to re-send in the last 24 hours',
          undefined,
          'ask_resend_rate_limited',
        );
      }
      await this.audit.record(tx, context, {
        action: 'inbound_email.ask_resend',
        objectId: mailId,
        result: 'allowed',
        metadata: { attachment_count: resendable.length },
      });
      // A reply lands on the organization's active inbound address, not the no-reply mailbox.
      const address = await this.mails.findActiveAddress(tx, context);
      const replyTo = address ? `${address.localPart}@${INBOUND_DOMAIN}` : null;
      const label = await this.mails.organizationLabel(tx, context);
      return {
        to,
        replyTo,
        subject: mail.subject,
        names: resendable.map((row) => row.name),
        workspaceName: label?.name ?? '',
        language: label?.defaultLocale.toLowerCase().startsWith('ar') === true ? 'ar' : 'en',
      } as const;
    });

    if (this.mailer === null)
      return { id: mailId, attachments: plan.names.length, delivery: 'none' };
    try {
      const delivery = await this.mailer.send(
        forCompany(composeAskResendEmail(plan), context.organizationId),
      );
      return { id: mailId, attachments: plan.names.length, delivery };
    } catch {
      // The ask is recorded; a transport failure is reported, never retried here.
      return { id: mailId, attachments: plan.names.length, delivery: 'failed' };
    }
  }

  private async open(
    context: TenantContext,
    row: {
      readonly id: string;
      readonly addressId: string;
      readonly name: string;
      readonly sizeBytes: number;
    },
    mimeType: string,
  ): Promise<ServedAttachment> {
    if (this.store === null) throw notAvailable();
    const objectKey = attachmentObjectKey(context.organizationId, row.addressId, row.id);
    try {
      const opened = await this.store.openObject({ zone: 'private', objectKey });
      if (opened.sizeBytes !== row.sizeBytes) {
        destroy(opened.stream);
        throw notAvailable();
      }
      return { stream: opened.stream, sizeBytes: opened.sizeBytes, mimeType, fileName: row.name };
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw notAvailable();
      throw error;
    }
  }
}

/** A name safe to quote in plain text: no control characters, no scheme, bounded. */
export function plainName(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, ' ')
      .replace(/[a-z][a-z0-9+.-]*:\/\//giu, '')
      .replace(/\bwww\./giu, 'www ')
      .trim()
      .slice(0, 100) || 'attachment'
  );
}

/**
 * EMAIL-COPY K13: one language per mail (the workspace's), signed [WS] with reply line R2 (a
 * reply lands on the workspace's request address). No link of any kind.
 */
export function composeAskResendEmail(facts: {
  readonly to: string;
  readonly replyTo?: string | null;
  readonly subject: string | null;
  readonly names: readonly string[];
  readonly workspaceName?: string;
  readonly language?: 'en' | 'ar';
}): MailMessage {
  const language = facts.language ?? 'en';
  const ar = language === 'ar';
  const studio = plainName(facts.workspaceName ?? '');
  const named = studio !== '' && studio !== 'attachment';
  const subjectLine = plainName(facts.subject ?? '').slice(0, 150);
  const listed = facts.names.slice(0, MAX_NAMES).map((name) => `- ${plainName(name)}`);
  if (facts.names.length > MAX_NAMES) listed.push(`- (+${facts.names.length - MAX_NAMES})`);
  const lead = ar
    ? `وصلت رسالتك إلى ${named ? studio : 'فريقنا'}، لكن تعذّر قبول هذه المرفقات:`
    : `${named ? studio : 'We'} received your e-mail, but these attachments could not be accepted:`;
  const ask = ar
    ? 'من فضلك أعد إرسالها بصيغة PDF أو PNG، وكل ملف أقل من 10 ميغابايت، في ردّ على هذه الرسالة.'
    : 'Please send them again as PDF or PNG files, each under 10 MB, in a reply to this e-mail.';
  const signature = named
    ? workspaceSignOff(
        language,
        studio,
        facts.replyTo
          ? workspaceReplyLine(language, 'requests', { workspaceName: studio })
          : workspaceReplyLine(language, 'none', { workspaceName: studio }),
      )
    : [];
  const text = [
    anchored(language, greeting(language, undefined)),
    [anchored(language, lead), ...listed].join('\n'),
    anchored(language, ask),
    ...(signature.length === 0 ? [] : [anchored(language, signature.join('\n'))]),
  ].join('\n\n');
  const fallbackSubject = ar ? 'من فضلك أعد إرسال المرفقات' : 'Please send your attachments again';
  return {
    to: facts.to,
    language,
    subject: anchored(
      language,
      subjectLine !== 'attachment' && subjectLine !== ''
        ? `${ar ? 'رد' : 'Re'}: ${subjectLine}`
        : fallbackSubject,
    ),
    text,
    ...(facts.replyTo ? { replyTo: facts.replyTo } : {}),
    ...(named
      ? {
          audience: 'client' as const,
          actingFor: {
            workspaceName: studio,
            replyRoute: facts.replyTo ? ('requests' as const) : ('none' as const),
          },
        }
      : {}),
    templateKey: ASK_RESEND_TEMPLATE,
  };
}

function notAvailable(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'not_available');
}

function destroy(stream: NodeJS.ReadableStream): void {
  const candidate = stream as { destroy?: () => void; destroyed?: boolean };
  if (typeof candidate.destroy === 'function' && !candidate.destroyed) candidate.destroy();
}
