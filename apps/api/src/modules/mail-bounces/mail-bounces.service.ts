import { authorize, isUuid, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { emailAddressHash, parseDeliveryReport, readBounceMessageId } from '@tmanage/mail';
import type { BounceReference, BounceSuppressionLookup, DeliveryReport } from '@tmanage/mail';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MailBounceKind, MailRecipientBounceRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { MailBouncesRepository } from './mail-bounces.repository.js';
import type { BounceState } from './mail-bounces.repository.js';

/**
 * 56-26 — mail bounce handling.
 *
 * **Intake** (`record`): the raw bounce, already authenticated by the intake controller. The RFC
 * 3464 report is read (`parseDeliveryReport`); the first quoted `Message-ID` that verifies under
 * the bounce key (`readBounceMessageId`) decides the company and the recipient's address hash. No
 * address in the report is ever used, so a forged report cannot name an arbitrary address or
 * another company's recipient. Per (company, address): the first hard bounce, or the third soft
 * one within {@link SOFT_WINDOW_MS}, suppresses the address; a report for the same message counts
 * once (a hard report after a soft one for the same message is counted as the hard one).
 *
 * **Guard** ({@link MailBounceLookup}): the lookup `BounceGuardMailer` asks before company mail goes.
 *
 * **Admin** (`status`, `clear`): an owner or admin types an address to see whether it bounced in
 * their company, and clears the suppression (audited `mail_bounce.cleared`). `org.security.manage`,
 * decided again here. The address arrives in the body (never a URL) and is only hashed.
 */

export const SOFT_LIMIT = 3;
export const SOFT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const POLICY = 'mail-bounces';
const MAX_ADDRESS = 320;

/** What the intake did. The controller answers the same to the caller whatever this is. */
export type BounceOutcome = 'not_a_report' | 'unmatched' | 'duplicate' | 'recorded' | 'suppressed';

/** What an admin sees for one address in their company. */
export interface MailBounceStatus {
  readonly status: 'clear' | 'bounced' | 'suppressed';
  readonly lastKind: MailBounceKind | null;
  readonly lastStatus: string | null;
  readonly lastBouncedAt: string | null;
  readonly suppressedAt: string | null;
}

/** The record after one more bounce, or `null` when the report is one already counted. */
export function nextBounceState(
  existing: MailRecipientBounceRow | null,
  report: Pick<DeliveryReport, 'kind' | 'status'>,
  reference: string,
  at: Date,
): BounceState | null {
  const hard = report.kind === 'hard';
  if (existing === null) {
    return {
      hardCount: hard ? 1 : 0,
      softCount: hard ? 0 : 1,
      lastKind: report.kind,
      lastStatus: report.status,
      lastMessageRef: reference,
      lastBouncedAt: at,
      suppressedAt: hard ? at : null,
    };
  }
  const sameMessage = existing.lastMessageRef === reference;
  const escalates = sameMessage && hard && existing.lastKind === 'soft';
  if (sameMessage && !escalates) return null;
  let hardCount = existing.hardCount;
  let softCount = existing.softCount;
  if (escalates) {
    softCount = Math.max(0, softCount - 1);
    hardCount += 1;
  } else if (hard) {
    hardCount += 1;
  } else {
    const stale = at.getTime() - existing.lastBouncedAt.getTime() > SOFT_WINDOW_MS;
    softCount = stale ? 1 : softCount + 1;
  }
  const suppress = hard || softCount >= SOFT_LIMIT;
  return {
    hardCount,
    softCount,
    lastKind: report.kind,
    lastStatus: report.status,
    lastMessageRef: reference,
    lastBouncedAt: at,
    suppressedAt: existing.suppressedAt ?? (suppress ? at : null),
  };
}

function requireMailAdmin(context: TenantContext, principal: Principal): void {
  const verdict = authorize({
    principal,
    capability: 'org.security.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!verdict.allowed) {
    throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
  }
}

function addressFrom(body: unknown): string {
  const value =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['address']
      : undefined;
  const address = typeof value === 'string' ? value.trim() : '';
  const at = address.indexOf('@');
  if (address.length > MAX_ADDRESS || at <= 0 || at === address.length - 1 || /\s/u.test(address)) {
    throw new ApiError(422, 'validation_failed', 'The request body is invalid', [
      { field: 'address', message: 'must be an e-mail address' },
    ]);
  }
  return address;
}

function statusOf(row: MailRecipientBounceRow | null): MailBounceStatus {
  if (row === null || (row.suppressedAt === null && row.hardCount + row.softCount === 0)) {
    return {
      status: 'clear',
      lastKind: null,
      lastStatus: null,
      lastBouncedAt: null,
      suppressedAt: null,
    };
  }
  return {
    status: row.suppressedAt === null ? 'bounced' : 'suppressed',
    lastKind: row.lastKind,
    lastStatus: row.lastStatus,
    lastBouncedAt: row.lastBouncedAt.toISOString(),
    suppressedAt: row.suppressedAt === null ? null : row.suppressedAt.toISOString(),
  };
}

/** The guard's question, on the API's database: one probe bound to the message's company. */
export class MailBounceLookup implements BounceSuppressionLookup {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: MailBouncesRepository = new MailBouncesRepository(),
  ) {}

  async isBounceSuppressed(organizationId: string, addressHash: string): Promise<boolean> {
    const context = createServiceContext({
      organizationId,
      correlationId: uuidv7(),
      policyVersion: POLICY,
    });
    return this.database.read(context, (runner) =>
      this.repository.isSuppressed(runner, context, addressHash),
    );
  }
}

export class MailBouncesService {
  constructor(
    private readonly database: TenantDatabase,
    /** `deriveBounceKey(SESSION_SECRET)`; `null` = no server secret, nothing ever matches. */
    private readonly key: Buffer | null,
    private readonly audit: Pick<AuditService, 'record'>,
    private readonly repository: MailBouncesRepository = new MailBouncesRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The first quoted Message-ID this key signed, if any. */
  private reference(report: DeliveryReport): BounceReference | null {
    if (this.key === null) return null;
    for (const candidate of report.messageIds) {
      const reference = readBounceMessageId(this.key, candidate);
      if (reference !== null) return reference;
    }
    return null;
  }

  async record(raw: Uint8Array, correlationId: string): Promise<BounceOutcome> {
    const report = parseDeliveryReport(raw);
    if (report === null) return 'not_a_report';
    const reference = this.reference(report);
    if (reference === null) return 'unmatched';
    const context = createServiceContext({
      organizationId: reference.organizationId,
      // A caller's id that is not a canonical UUID is replaced, never trusted as one.
      correlationId: isUuid(correlationId) ? correlationId : uuidv7(),
      policyVersion: POLICY,
    });
    const at = this.now();
    return this.database.transaction(context, async (runner) => {
      const existing = await this.repository.findForUpdate(runner, context, reference.addressHash);
      const next = nextBounceState(existing, report, reference.reference, at);
      if (next === null) return 'duplicate';
      if (existing === null) {
        await this.repository.insert(runner, context, reference.addressHash, next, at);
      } else {
        await this.repository.update(runner, context, reference.addressHash, next, at);
      }
      return next.suppressedAt === null ? 'recorded' : 'suppressed';
    });
  }

  async status(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<MailBounceStatus> {
    requireMailAdmin(context, principal);
    const hash = emailAddressHash(addressFrom(body));
    return statusOf(
      await this.database.read(context, (runner) => this.repository.find(runner, context, hash)),
    );
  }

  async clear(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<MailBounceStatus> {
    requireMailAdmin(context, principal);
    const hash = emailAddressHash(addressFrom(body));
    await this.database.transaction(context, async (runner) => {
      const row = await this.repository.findForUpdate(runner, context, hash);
      await this.repository.clear(runner, context, hash, this.now());
      await this.audit.record(runner, context, {
        action: 'mail_bounce.cleared',
        result: 'allowed',
        objectId: null,
        metadata: { was_suppressed: row?.suppressedAt != null },
      });
    });
    return statusOf(null);
  }
}
