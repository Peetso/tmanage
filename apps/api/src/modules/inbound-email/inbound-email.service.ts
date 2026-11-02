import { randomBytes } from 'node:crypto';
import { authorize, uuidv7 } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  InboundEmailAddressRow,
  InboundEmailAttachmentRow,
} from '../../common/database/schema.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { InboundEmailRepository, LogCursor } from './inbound-email.repository.js';
import {
  INBOUND_DOMAIN,
  MAX_ATTACHMENTS,
  PER_ADDRESS_PER_HOUR,
  attachmentState,
  authResultOf,
  bodyOf,
  decideOutcome,
  decodeRfc2047,
  localPartFor,
  messageIdHash,
  parseRecipient,
  senderAddress,
  suffixFrom,
} from './inbound-mail-rules.js';
import type { AuthResult, InboundOutcome, ParsedInboundMessage } from './inbound-mail-rules.js';

/**
 * R21-f — 54-12 inbound e-mail core and the 54-12a attachment rule.
 *
 * Org side (authorized in the controller and again here): one active request address per
 * organization (`requests+<slug>-<6>@INBOUND_EMAIL_DOMAIN`), rotate it, read the inbound log
 * (subjects, outcome, attachment chips — never a body), read one mail's attachment metadata, and
 * trust a held mail whose DMARC did not pass.
 *
 * Ingest ({@link InboundEmailService.ingest}): takes an already-parsed message, so the later
 * poller or a JSON inbound webhook feeds it unchanged. No principal: the recipient's local part is
 * resolved on `bootstrapRead(['inbound_email_addresses'])` (reason `inbound_email_address_lookup`)
 * and everything after runs under a service context of that address's organization.
 *
 * NOT built here (cut, stated so nobody relies on it): the IMAP / Gmail / Graph fetch (no IMAP or
 * MIME library is in the lockfile and the mailbox is an hPanel step), attachment BYTES (every row is
 * metadata — no fetch, preview, download or scanner call, so no row is ever `clean`), the
 * member -> work item outcome, the "ask the sender to re-send" reply, and the triage screen.
 *
 * The per-address hour budget is in process (`createFixedWindowLimiter`): a restart forgets the
 * window and a second process would count separately — the limiter's own stated limits.
 */

export const BOOTSTRAP_REASON = 'inbound_email_address_lookup';
const SERVICE_POLICY = 'inbound-email';
const HOUR_MS = 60 * 60 * 1000;
const LOG_PAGE = 50;
const MAX_SUBJECT = 500;
const MAX_TITLE = 200;
const ADDRESS_ATTEMPTS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export type IngestStatus =
  'dropped' | 'dropped_rate_limited' | 'duplicate' | 'client_request' | 'held';

export interface IngestResult {
  readonly status: IngestStatus;
  readonly inboundEmailId?: string;
  readonly reason?: string;
}

export interface InboundAddressView {
  readonly id: string;
  readonly address: string;
  readonly status: string;
  readonly defaultProjectId: string | null;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
}

export interface AttachmentChip {
  readonly name: string;
  readonly sizeBytes: number;
  readonly state: string;
}

export interface InboundLogEntry {
  readonly id: string;
  readonly fromEmail: string;
  readonly subject: string | null;
  readonly authResult: string;
  readonly outcome: string;
  readonly outcomeReason: string | null;
  readonly linkedObjectType: string | null;
  readonly linkedObjectId: string | null;
  readonly droppedAttachments: number;
  readonly trustedAt: string | null;
  readonly receivedAt: string;
  readonly attachments: readonly AttachmentChip[];
}

export interface InboundAttachmentView {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly declaredType: string | null;
  readonly state: string;
  readonly createdAt: string;
}

export interface TrustResult {
  readonly id: string;
  readonly outcome: string;
  readonly outcomeReason: string | null;
  readonly linkedObjectType: string | null;
  readonly linkedObjectId: string | null;
  readonly attachmentsReleased: number;
}

export interface InboundEmailDeps {
  readonly audit?: Pick<AuditEventsRepository, 'append'>;
  readonly requests?: Pick<ClientRequestsRepository, 'submit'>;
  readonly limiter?: RequestAdmission;
  readonly random?: (size: number) => Buffer;
  readonly now?: () => Date;
  readonly domain?: string;
}

export function toAddressView(row: InboundEmailAddressRow, domain: string): InboundAddressView {
  return {
    id: row.id,
    address: `${row.localPart}@${domain}`,
    status: row.status,
    defaultProjectId: row.defaultProjectId,
    createdAt: row.createdAt.toISOString(),
    rotatedAt: row.rotatedAt ? row.rotatedAt.toISOString() : null,
  };
}

function toAttachmentView(row: InboundEmailAttachmentRow): InboundAttachmentView {
  return {
    id: row.id,
    name: row.name,
    sizeBytes: row.sizeBytes,
    declaredType: row.declaredType,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
  };
}

export function encodeLogCursor(cursor: LogCursor): string {
  return Buffer.from(`${cursor.receivedAt.toISOString()}|${cursor.id}`, 'utf8').toString(
    'base64url',
  );
}

export function decodeLogCursor(value: unknown): LogCursor | null {
  if (value === undefined || value === null || value === '') return null;
  const invalid = (): ApiError =>
    new ApiError(400, 'validation_failed', 'The request is invalid', [
      { field: 'cursor', message: 'is not a valid cursor' },
    ]);
  if (typeof value !== 'string' || value.length > 200) throw invalid();
  const [iso, id] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime()) || id === undefined || !/^[0-9a-f-]{36}$/u.test(id)) {
    throw invalid();
  }
  return { receivedAt: at, id };
}

const isDuplicate = (error: unknown): boolean =>
  error !== null &&
  typeof error === 'object' &&
  (error as { code?: unknown }).code === 'ER_DUP_ENTRY';

export class InboundEmailService {
  private readonly audit: Pick<AuditEventsRepository, 'append'>;
  private readonly requests: Pick<ClientRequestsRepository, 'submit'>;
  private readonly limiter: RequestAdmission;
  private readonly random: (size: number) => Buffer;
  private readonly now: () => Date;
  private readonly domain: string;

  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: InboundEmailRepository,
    deps: InboundEmailDeps = {},
  ) {
    this.audit = deps.audit ?? new AuditEventsRepository();
    this.requests = deps.requests ?? new ClientRequestsRepository();
    this.limiter =
      deps.limiter ?? createFixedWindowLimiter({ windowMs: HOUR_MS, max: PER_ADDRESS_PER_HOUR });
    this.random = deps.random ?? ((size) => randomBytes(size));
    this.now = deps.now ?? (() => new Date());
    this.domain = deps.domain ?? INBOUND_DOMAIN;
  }

  // ── Org side ──────────────────────────────────────────────────────────────

  async address(
    context: TenantContext,
    principal: Principal,
  ): Promise<{ readonly address: InboundAddressView | null }> {
    requireCapability(principal, context, 'org.manage');
    const row = await this.database.read(context, (runner) =>
      this.repository.findActiveAddress(runner, context),
    );
    return { address: row ? toAddressView(row, this.domain) : null };
  }

  async createAddress(
    context: TenantContext,
    principal: Principal,
    orgSlug: string,
    body: { readonly defaultProjectId?: unknown } | undefined,
  ): Promise<InboundAddressView> {
    requireCapability(principal, context, 'org.manage');
    const raw = body?.defaultProjectId;
    if (raw !== undefined && raw !== null && (typeof raw !== 'string' || raw === '')) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'defaultProjectId', message: 'must be a project id or null' },
      ]);
    }
    const defaultProjectId = typeof raw === 'string' ? raw : null;
    const at = this.now();
    const row = await this.withFreshLocalPart(orgSlug, (localPart) =>
      this.database.transaction(context, async (runner) => {
        if (await this.repository.findActiveAddress(runner, context, true)) {
          throw new ApiError(
            409,
            'conflict',
            'This organization already has an inbound address',
            undefined,
            'address_exists',
          );
        }
        if (
          defaultProjectId !== null &&
          !(await this.repository.projectExists(runner, context, defaultProjectId))
        ) {
          throw unknownProject();
        }
        const id = uuidv7();
        const created = await this.repository.insertAddress(
          runner,
          context,
          { id, localPart, defaultProjectId, policyJson: policyJson() },
          at,
        );
        await this.audit.append(runner, context, {
          action: 'inbound_email_address.created',
          result: 'allowed',
          objectId: id,
          metadata: { has_default_project: defaultProjectId !== null },
        });
        return created;
      }),
    );
    return toAddressView(row, this.domain);
  }

  async rotate(
    context: TenantContext,
    principal: Principal,
    orgSlug: string,
  ): Promise<InboundAddressView> {
    requireCapability(principal, context, 'org.manage');
    const at = this.now();
    const row = await this.withFreshLocalPart(orgSlug, (localPart) =>
      this.database.transaction(context, async (runner) => {
        const current = await this.repository.findActiveAddress(runner, context, true);
        if (!current) {
          throw new ApiError(
            404,
            'not_found',
            MESSAGES.notFound,
            undefined,
            'inbound_address_not_found',
          );
        }
        await this.repository.markRotated(runner, context, current.id, at);
        const id = uuidv7();
        const created = await this.repository.insertAddress(
          runner,
          context,
          {
            id,
            localPart,
            defaultProjectId: current.defaultProjectId,
            policyJson: current.policyJson,
          },
          at,
        );
        await this.audit.append(runner, context, {
          action: 'inbound_email_address.rotated',
          result: 'allowed',
          objectId: id,
          metadata: { previous_address_id: current.id },
        });
        return created;
      }),
    );
    return toAddressView(row, this.domain);
  }

  async log(
    context: TenantContext,
    principal: Principal,
    cursorParam: unknown,
  ): Promise<{ readonly entries: readonly InboundLogEntry[]; readonly nextCursor: string | null }> {
    requireCapability(principal, context, 'client_request.triage');
    const cursor = decodeLogCursor(cursorParam);
    const { rows, attachments } = await this.database.read(context, async (runner) => {
      const page = await this.repository.listEmails(runner, context, cursor, LOG_PAGE + 1);
      const ids = page.slice(0, LOG_PAGE).map((row) => row.id);
      return {
        rows: page,
        attachments: await this.repository.listAttachments(runner, context, ids),
      };
    });
    const byMail = new Map<string, AttachmentChip[]>();
    for (const a of attachments) {
      const list = byMail.get(a.inboundEmailId) ?? [];
      list.push({ name: a.name, sizeBytes: a.sizeBytes, state: a.state });
      byMail.set(a.inboundEmailId, list);
    }
    const shown = rows.slice(0, LOG_PAGE);
    const last = shown[shown.length - 1];
    return {
      // An explicit projection: no body, no message hash, no address id.
      entries: shown.map((row) => ({
        id: row.id,
        fromEmail: row.fromEmail,
        subject: row.subject,
        authResult: row.authResult,
        outcome: row.outcome,
        outcomeReason: row.outcomeReason,
        linkedObjectType: row.linkedObjectType,
        linkedObjectId: row.linkedObjectId,
        droppedAttachments: row.droppedAttachments,
        trustedAt: row.trustedAt ? row.trustedAt.toISOString() : null,
        receivedAt: row.receivedAt.toISOString(),
        attachments: byMail.get(row.id) ?? [],
      })),
      nextCursor:
        rows.length > LOG_PAGE && last
          ? encodeLogCursor({ receivedAt: last.receivedAt, id: last.id })
          : null,
    };
  }

  async attachments(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<{ readonly attachments: readonly InboundAttachmentView[] }> {
    requireCapability(principal, context, 'client_request.triage');
    const rows = await this.database.read(context, async (runner) => {
      if (!(await this.repository.findEmail(runner, context, id))) throw mailNotFound();
      return this.repository.listAttachments(runner, context, [id]);
    });
    return { attachments: rows.map(toAttachmentView) };
  }

  async trust(context: TenantContext, principal: Principal, id: string): Promise<TrustResult> {
    requireCapability(principal, context, 'client_request.triage');
    const at = this.now();
    return this.database.transaction(context, async (runner) => {
      const mail = await this.repository.findEmail(runner, context, id, true);
      if (!mail) throw mailNotFound();
      if (mail.trustedAt !== null) {
        throw new ApiError(
          409,
          'conflict',
          'This e-mail is already trusted',
          undefined,
          'already_trusted',
        );
      }
      if (mail.outcome !== 'held' || mail.authResult === 'pass') {
        throw new ApiError(
          409,
          'conflict',
          'Only a held e-mail that failed authentication can be trusted',
          undefined,
          'not_trustable',
        );
      }
      const address = await this.repository.findAddressById(runner, context, mail.addressId);
      const decided = await this.decide(runner, context, 'pass', mail.fromEmail, address);
      let linkedObjectId: string | null = null;
      if (decided.outcome.outcome === 'client_request' && decided.sender && decided.projectId) {
        const request = await this.requests.submit(runner, context, {
          projectId: decided.projectId,
          clientOrganizationId: decided.sender.clientOrganizationId,
          submittedByUserId: decided.sender.userId,
          title: titleOf(mail.subject),
          description: mail.bodyText ?? '',
        });
        linkedObjectId = request.id;
      }
      const outcome = decided.outcome.outcome;
      const outcomeReason = decided.outcome.outcome === 'held' ? decided.outcome.reason : null;
      const linkedObjectType = linkedObjectId !== null ? 'client_request' : null;
      await this.repository.markTrusted(
        runner,
        context,
        id,
        { trustedBy: principal.userId, outcome, outcomeReason, linkedObjectType, linkedObjectId },
        at,
      );
      const attachmentsReleased = await this.repository.releaseWaitingAttachments(
        runner,
        context,
        id,
        at,
      );
      await this.audit.append(runner, context, {
        action: 'inbound_email.trusted',
        result: 'allowed',
        objectId: id,
        metadata: { outcome, attachments_released: attachmentsReleased },
      });
      return { id, outcome, outcomeReason, linkedObjectType, linkedObjectId, attachmentsReleased };
    });
  }

  // ── Ingest ────────────────────────────────────────────────────────────────

  async ingest(message: ParsedInboundMessage): Promise<IngestResult> {
    const localPart = parseRecipient(message.to, this.domain);
    const from = senderAddress(message.from);
    if (localPart === null || from === null) return { status: 'dropped' };
    // A fetcher's id that is not a canonical UUID is replaced, never trusted as one.
    const correlationId = UUID_PATTERN.test(message.correlationId)
      ? message.correlationId
      : uuidv7();
    const address = await this.database.bootstrapRead(
      {
        correlationId,
        reason: BOOTSTRAP_REASON,
        tables: ['inbound_email_addresses'],
      },
      (runner) => this.repository.findAddressByLocalPart(runner, localPart),
    );
    if (!address || address.status !== 'active') return { status: 'dropped' };
    if (!this.limiter(address.id)) return { status: 'dropped_rate_limited' };

    const context = createServiceContext({
      organizationId: address.organizationId,
      correlationId,
      policyVersion: SERVICE_POLICY,
    });
    const subject =
      message.subject === null ? null : decodeRfc2047(message.subject).slice(0, MAX_SUBJECT);
    const hash = messageIdHash(message.messageId, { from, date: message.date, subject });
    const authResult = authResultOf(message.headers);
    const body = bodyOf(message);
    const kept = message.attachments.slice(0, MAX_ATTACHMENTS);
    const dropped = message.attachments.length - kept.length;
    const at = this.now();
    const id = uuidv7();

    try {
      return await this.database.transaction(context, async (runner): Promise<IngestResult> => {
        if (await this.repository.findByMessageHash(runner, context, hash)) {
          return { status: 'duplicate' };
        }
        const decided = await this.decide(runner, context, authResult, from, address);
        let linkedObjectId: string | null = null;
        if (decided.outcome.outcome === 'client_request' && decided.sender && decided.projectId) {
          const request = await this.requests.submit(runner, context, {
            projectId: decided.projectId,
            clientOrganizationId: decided.sender.clientOrganizationId,
            submittedByUserId: decided.sender.userId,
            title: titleOf(subject),
            description: body,
          });
          linkedObjectId = request.id;
        }
        const reason = decided.outcome.outcome === 'held' ? decided.outcome.reason : null;
        await this.repository.insertEmail(
          runner,
          context,
          {
            id,
            addressId: address.id,
            messageIdHash: hash,
            fromEmail: from,
            subject,
            bodyText: body === '' ? null : body,
            authResult,
            outcome: decided.outcome.outcome,
            outcomeReason: reason,
            linkedObjectType: linkedObjectId !== null ? 'client_request' : null,
            linkedObjectId,
            droppedAttachments: dropped,
          },
          at,
        );
        await this.repository.insertAttachments(
          runner,
          context,
          kept.map((a) => ({
            id: uuidv7(),
            inboundEmailId: id,
            name: a.name.slice(0, 255),
            sizeBytes: Math.max(0, Math.min(Math.trunc(a.sizeBytes), 0xffffffff)),
            declaredType: a.declaredType?.slice(0, 127) ?? null,
            state: attachmentState({
              sizeBytes: a.sizeBytes,
              declaredType: a.declaredType,
              name: a.name,
              head: a.head,
              authResult,
            }),
          })),
          at,
        );
        return {
          status: decided.outcome.outcome,
          inboundEmailId: id,
          ...(reason !== null ? { reason } : {}),
        };
      });
    } catch (error) {
      // Two deliveries of one message racing past the read: the unique key decides.
      if (isDuplicate(error)) return { status: 'duplicate' };
      throw error;
    }
  }

  private async decide(
    runner: Parameters<Parameters<TenantDatabase['transaction']>[1]>[0],
    context: TenantContext,
    authResult: AuthResult,
    from: string,
    address: InboundEmailAddressRow | null,
  ): Promise<{
    readonly outcome: InboundOutcome;
    readonly sender: { readonly clientOrganizationId: string; readonly userId: string } | null;
    readonly projectId: string | null;
  }> {
    if (authResult !== 'pass') {
      return {
        outcome: decideOutcome({
          authResult,
          senderClient: null,
          defaultProjectId: null,
          projectShared: false,
        }),
        sender: null,
        projectId: null,
      };
    }
    const sender = await this.repository.findSenderClient(runner, context, from);
    const projectId = address?.defaultProjectId ?? null;
    const projectShared =
      sender !== null &&
      projectId !== null &&
      (await this.repository.projectExists(runner, context, projectId)) &&
      (await this.repository.isProjectShared(
        runner,
        context,
        projectId,
        sender.clientOrganizationId,
      ));
    return {
      outcome: decideOutcome({
        authResult,
        senderClient: sender,
        defaultProjectId: projectId,
        projectShared,
      }),
      sender,
      projectId,
    };
  }

  /** A fresh random local part; a collision on the global unique key retries with a new one. */
  private async withFreshLocalPart<T>(
    orgSlug: string,
    work: (localPart: string) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await work(localPartFor(orgSlug, suffixFrom(this.random(6))));
      } catch (error) {
        if (!isDuplicate(error) || attempt >= ADDRESS_ATTEMPTS) throw error;
      }
    }
  }
}

function policyJson(): string {
  return JSON.stringify({
    perHour: PER_ADDRESS_PER_HOUR,
    maxAttachments: MAX_ATTACHMENTS,
  });
}

function titleOf(subject: string | null): string {
  const trimmed = (subject ?? '').trim();
  return (trimmed === '' ? '(no subject)' : trimmed).slice(0, MAX_TITLE);
}

/** Org-scoped `authorize()`; a client principal never holds these and is refused here too. */
export function requireCapability(
  principal: Principal,
  context: TenantContext,
  capability: Capability,
): void {
  const verdict =
    principal.kind === 'client'
      ? { allowed: false }
      : authorize({
          principal,
          capability,
          resource: {
            organizationId: context.organizationId,
            projectId: null,
            audience: 'internal',
            lifecycle: 'active',
          },
        });
  if (!verdict.allowed) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'inbound_email_denied');
  }
}

function mailNotFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'inbound_email_not_found');
}

function unknownProject(): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field: 'defaultProjectId', message: 'must name an active project of this organization' },
  ]);
}
