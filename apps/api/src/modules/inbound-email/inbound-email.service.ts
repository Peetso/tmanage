import { createHash, randomBytes } from 'node:crypto';
import { authorize, uuidv7 } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import {
  SERVICE_PRINCIPAL_ID,
  createServiceContext,
} from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  InboundEmailAddressRow,
  InboundEmailAttachmentRow,
} from '../../common/database/schema.js';
import { AuditEventsRepository } from '../audit/audit-events.repository.js';
import { ClientRequestsRepository } from '../requests/client-requests.repository.js';
import type { WorkItemsService } from '../work/work-items.service.js';
import type { InboundEmailRepository, LogCursor } from './inbound-email.repository.js';
import {
  HEAD_BYTES,
  INBOUND_DOMAIN,
  MAX_ATTACHMENTS,
  MAX_DAILY_ATTACHMENT_BYTES,
  PER_ADDRESS_PER_HOUR,
  attachmentObjectKey,
  attachmentState,
  authResultOf,
  bodyOf,
  decideOutcome,
  decodeRfc2047,
  localPartFor,
  memberOutcomeOf,
  messageIdHash,
  parseRecipient,
  senderAddress,
  suffixFrom,
} from './inbound-mail-rules.js';
import type {
  AttachmentState,
  AuthResult,
  HeldReason,
  InboundOutcome,
  ParsedInboundMessage,
  SenderMember,
} from './inbound-mail-rules.js';

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
 * R22-c added: the member -> work item outcome (created through `WorkItemsService.create` under a
 * service principal scoped to the address's default project, the member as owner), and attachment
 * BYTES from the JSON webhook — a passing mail's `scanning` attachments are parked write-once in the
 * quarantine zone under {@link attachmentObjectKey} with their SHA-256; a failing mail's bytes are
 * dropped before any write (54-12a rule 5) and the org's 200 MiB/day cap turns the rest
 * `too_large`. An object parked in a transaction that then rolls back (a racing duplicate) is left
 * under the tenant prefix for the erasure walk — it has no row and is never served.
 *
 * NOT built here (cut, stated so nobody relies on it): the IMAP / Gmail / Graph fetch (no IMAP or
 * MIME library is in the lockfile and the mailbox is an hPanel step), the scan pass (no row is
 * ever `clean` here), preview/download, the "ask the sender to re-send" reply, and the triage
 * screen.
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
  'dropped' | 'dropped_rate_limited' | 'duplicate' | 'client_request' | 'work_item' | 'held';

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
  /** R22-c: the member -> work item outcome. Absent: that outcome is held `work_item_refused`. */
  readonly workItems?: Pick<WorkItemsService, 'create'>;
  /** R22-c: where a passing mail's attachment bytes are parked. Absent: rows are `unavailable`. */
  readonly store?: Pick<ObjectStore, 'putQuarantine'>;
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
  private readonly workItems: Pick<WorkItemsService, 'create'> | null;
  private readonly store: Pick<ObjectStore, 'putQuarantine'> | null;

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
    this.workItems = deps.workItems ?? null;
    this.store = deps.store ?? null;
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
    const trusted = await this.database.transaction(context, async (runner) => {
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
      // R22-c: the bytes were never kept (rule 5) and a push cannot be re-fetched.
      const attachmentsReleased = await this.repository.expireWaitingAttachments(
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
      const result: TrustResult = {
        id,
        outcome,
        outcomeReason,
        linkedObjectType,
        linkedObjectId,
        attachmentsReleased,
      };
      return { result, decided, mail };
    });
    if (trusted.decided.outcome.outcome !== 'work_item') return trusted.result;
    const filed = await this.fileWorkItem(context, id, {
      projectId: trusted.decided.projectId,
      member: trusted.decided.member,
      subject: trusted.mail.subject,
      body: trusted.mail.bodyText ?? '',
    });
    return { ...trusted.result, ...filed };
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
    const dropped = Math.max(0, message.attachments.length - MAX_ATTACHMENTS);
    // 54-12a rule 5: a mail that did not pass DMARC keeps metadata only — its bytes are dropped
    // here, before anything could write them.
    const kept: KeptAttachment[] = message.attachments.slice(0, MAX_ATTACHMENTS).map((a) => {
      const bytes = authResult === 'pass' ? (a.bytes ?? null) : null;
      const sizeBytes = bytes !== null ? bytes.length : a.sizeBytes;
      const head = bytes !== null ? bytes.subarray(0, HEAD_BYTES) : a.head;
      return {
        id: uuidv7(),
        name: a.name,
        declaredType: a.declaredType,
        sizeBytes,
        bytes,
        state: attachmentState({
          sizeBytes,
          declaredType: a.declaredType,
          name: a.name,
          head,
          authResult,
        }),
      };
    });
    const at = this.now();
    const id = uuidv7();

    let result: { readonly ingest: IngestResult; readonly decided: Decided };
    try {
      result = await this.database.transaction(context, async (runner) => {
        if (await this.repository.findByMessageHash(runner, context, hash)) {
          const duplicate: IngestResult = { status: 'duplicate' };
          return { ingest: duplicate, decided: NO_DECISION };
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
        const rows = await this.parkAttachments(runner, context, address.id, kept, at);
        await this.repository.insertAttachments(
          runner,
          context,
          rows.map((row) => ({ ...row, inboundEmailId: id })),
          at,
        );
        const ingest: IngestResult = {
          status: decided.outcome.outcome,
          inboundEmailId: id,
          ...(reason !== null ? { reason } : {}),
        };
        return { ingest, decided };
      });
    } catch (error) {
      // Two deliveries of one message racing past the read: the unique key decides.
      if (isDuplicate(error)) return { status: 'duplicate' };
      throw error;
    }
    if (result.decided.outcome.outcome !== 'work_item') return result.ingest;
    const filed = await this.fileWorkItem(context, id, {
      projectId: result.decided.projectId,
      member: result.decided.member,
      subject,
      body,
    });
    return {
      status: filed.outcome,
      inboundEmailId: id,
      ...(filed.outcomeReason !== null ? { reason: filed.outcomeReason } : {}),
    };
  }

  /**
   * 54-12a: the state each kept attachment is recorded in, and — for a passing mail's `scanning`
   * rows — its bytes parked in quarantine with their SHA-256. Over the organization's daily bytes
   * a row is `too_large`; a `scanning` row with no bytes (or no store) is `unavailable`.
   */
  private async parkAttachments(
    runner: Parameters<Parameters<TenantDatabase['transaction']>[1]>[0],
    context: TenantContext,
    addressId: string,
    kept: readonly KeptAttachment[],
    at: Date,
  ): Promise<readonly ParkedAttachment[]> {
    const scanning = kept.some((a) => a.state === 'scanning');
    let usedToday = scanning
      ? await this.repository.dailyAttachmentBytes(runner, context, startOfUtcDay(at))
      : 0;
    const rows: ParkedAttachment[] = [];
    for (const a of kept) {
      let state: AttachmentState = a.state;
      let sha256: string | null = null;
      if (state === 'scanning') {
        if (usedToday + a.sizeBytes > MAX_DAILY_ATTACHMENT_BYTES) {
          state = 'too_large';
        } else if (a.bytes === null || this.store === null) {
          state = 'unavailable';
        } else {
          await this.store.putQuarantine({
            objectKey: attachmentObjectKey(context.organizationId, addressId, a.id),
            body: a.bytes,
          });
          sha256 = createHash('sha256').update(a.bytes).digest('hex');
          usedToday += a.sizeBytes;
        }
      }
      rows.push({
        id: a.id,
        name: a.name.slice(0, 255),
        sizeBytes: Math.max(0, Math.min(Math.trunc(a.sizeBytes), 0xffffffff)),
        declaredType: a.declaredType?.slice(0, 127) ?? null,
        state,
        sha256,
      });
    }
    return rows;
  }

  /**
   * R22-c: the member's mail becomes a work item in the address's default project, owned by the
   * member, created through `WorkItemsService.create` (its own transaction, audit and outbox event)
   * under a service principal that reaches that one project only. A refusal (archived project,
   * owner no longer a member, no service wired) leaves the mail held `work_item_refused`.
   */
  private async fileWorkItem(
    context: TenantContext,
    mailId: string,
    input: {
      readonly projectId: string | null;
      readonly member: SenderMember | null;
      readonly subject: string | null;
      readonly body: string;
    },
  ): Promise<FiledOutcome> {
    let linkedObjectId: string | null = null;
    if (this.workItems !== null && input.projectId !== null && input.member !== null) {
      try {
        const item = await this.workItems.create(
          context,
          inboundServicePrincipal(context.organizationId, input.projectId),
          {
            projectId: input.projectId,
            title: titleOf(input.subject),
            description: input.body === '' ? null : input.body,
            ownerUserId: input.member.userId,
          },
        );
        linkedObjectId = item.id;
      } catch {
        linkedObjectId = null;
      }
    }
    const filed: FiledOutcome =
      linkedObjectId !== null
        ? {
            outcome: 'work_item',
            outcomeReason: null,
            linkedObjectType: 'work_item',
            linkedObjectId,
          }
        : {
            outcome: 'held',
            outcomeReason: 'work_item_refused',
            linkedObjectType: null,
            linkedObjectId: null,
          };
    await this.database.transaction(context, (runner) =>
      this.repository.setOutcome(runner, context, mailId, filed),
    );
    return filed;
  }

  private async decide(
    runner: Parameters<Parameters<TenantDatabase['transaction']>[1]>[0],
    context: TenantContext,
    authResult: AuthResult,
    from: string,
    address: InboundEmailAddressRow | null,
  ): Promise<Decided> {
    if (authResult !== 'pass') {
      return {
        outcome: decideOutcome({
          authResult,
          senderClient: null,
          defaultProjectId: null,
          projectShared: false,
        }),
        sender: null,
        member: null,
        projectId: null,
      };
    }
    const sender = await this.repository.findSenderClient(runner, context, from);
    // A client contact is the narrower audience: the member lookup runs only for a non-client.
    const member =
      sender === null ? await this.repository.findSenderMember(runner, context, from) : null;
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
        senderMember: member,
        memberOutcome: memberOutcomeOf(address?.policyJson ?? null),
        defaultProjectId: projectId,
        projectShared,
      }),
      sender,
      member,
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

interface Decided {
  readonly outcome: InboundOutcome;
  readonly sender: { readonly clientOrganizationId: string; readonly userId: string } | null;
  readonly member: SenderMember | null;
  readonly projectId: string | null;
}

const NO_DECISION: Decided = {
  outcome: { outcome: 'held', reason: 'unknown_sender' },
  sender: null,
  member: null,
  projectId: null,
};

interface KeptAttachment {
  readonly id: string;
  readonly name: string;
  readonly declaredType: string | null;
  readonly sizeBytes: number;
  readonly bytes: Buffer | null;
  readonly state: AttachmentState;
}

interface ParkedAttachment {
  readonly id: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly declaredType: string | null;
  readonly state: AttachmentState;
  readonly sha256: string | null;
}

interface FiledOutcome {
  readonly outcome: 'work_item' | 'held';
  readonly outcomeReason: HeldReason | null;
  readonly linkedObjectType: string | null;
  readonly linkedObjectId: string | null;
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * R22-c: the principal an inbound member mail files work under — the platform's service id as a
 * plain `member` reaching exactly the address's default project (chosen by an org manager when
 * the address was set up), nothing org-wide. Same shape as `platformGrantPrincipal`.
 */
export function inboundServicePrincipal(organizationId: string, projectId: string): Principal {
  return {
    userId: SERVICE_PRINCIPAL_ID,
    organizationId,
    kind: 'internal',
    role: 'member',
    membershipId: SERVICE_PRINCIPAL_ID,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [projectId],
    hasOrgWideScope: false,
  };
}

function policyJson(): string {
  return JSON.stringify({
    perHour: PER_ADDRESS_PER_HOUR,
    maxAttachments: MAX_ATTACHMENTS,
    member_outcome: 'work_item',
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
