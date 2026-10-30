import { uuidv7 } from '@tmanage/domain';
import type { FieldCipher } from '@tmanage/domain/field-cipher';
import type { Mailer } from '@tmanage/mail';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import type { AssessPublicWrite } from '../public-abuse/public-abuse.guard.js';
import {
  SECURITY_REPORT_STATUSES,
  composeAcknowledgement,
  honeypotFilled,
  isResolved,
  newSecurityReportReference,
  parseSecurityReport,
  parseSecurityReportUpdate,
} from './security-report-content.js';
import type { SecurityReportStatus } from './security-report-content.js';
import type { SecurityReportRecord, SecurityReportStore } from './security-reports.repository.js';

/**
 * 56-17 — vulnerability disclosure, backend half (spec 56 §56-17, migration 0262).
 *
 * ## Public door (no session, no tenant)
 *
 * `submit` validates the text-only body, runs 52-21's `assessPublicWrite` (form proof, honeypot,
 * windows) and stores the report. The reporter is told one thing: `{ reference }`. A honeypot
 * hit, a spam verdict or a block-list hit all answer the same shape (a fresh reference that was
 * never stored for the first and last) — nothing to learn from the response. Only a window
 * refusal is a 429, as every public door answers it.
 *
 * The e-mail, when given, is a 56-02 FieldCipher envelope (`reporter_email`, owner = row id);
 * keyless means NULL is stored, never plaintext. The acknowledgement goes through the 56-31
 * `auth` lane (template `security_report_ack` → security@), only on an `allow` verdict, and
 * carries nothing the reporter typed except their own address — the door is not a mail relay.
 * A mail failure never fails the report.
 *
 * ## Platform triage
 *
 * List (no e-mail, no body), detail (decrypted e-mail, audited `platform.security_report_viewed`)
 * and update (status / credit, audited `platform.security_report_updated` in the same unit of
 * work). Reports are confidential: platform admins only, no tenant data.
 */

const CIPHER_PURPOSE = 'reporter_email' as const;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface SecurityReportSubmitRequest {
  readonly body: Readonly<Record<string, unknown>>;
  readonly ip: string | undefined;
  readonly acceptLanguage: string | undefined;
  readonly correlationId: string;
}

export type SecurityReportSubmitResult =
  | { readonly kind: 'accepted'; readonly reference: string }
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number };

export interface SecurityReportSummary {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly severityClaimed: string;
  readonly status: string;
  readonly riskDecision: string;
  readonly hasReporterEmail: boolean;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface SecurityReportDetail extends SecurityReportSummary {
  readonly body: string;
  readonly reporterName: string | null;
  /** Decrypted for the triager; `null` when none was given or it cannot be opened. */
  readonly reporterEmail: string | null;
  readonly language: string | null;
  readonly acknowledgedAt: string | null;
  readonly creditName: string | null;
  readonly creditPublic: boolean;
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function toSummary(row: SecurityReportRecord): SecurityReportSummary {
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    severityClaimed: row.severityClaimed,
    status: row.status,
    riskDecision: row.riskDecision,
    hasReporterEmail: row.reporterEmailEnc !== null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
  };
}

const notFound = (): ApiError =>
  new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'security_report_unknown');

export class SecurityReportsService {
  constructor(
    private readonly store: SecurityReportStore,
    private readonly cipher: FieldCipher,
    private readonly mailer: Mailer | null,
    private readonly assess: AssessPublicWrite | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ── Public ─────────────────────────────────────────────────────────────────

  async submit(request: SecurityReportSubmitRequest): Promise<SecurityReportSubmitResult> {
    const input = parseSecurityReport(request.body);
    // A filled honeypot is a script: answer like a success, store nothing, mail nobody.
    if (honeypotFilled(request.body)) {
      return { kind: 'accepted', reference: newSecurityReportReference() };
    }
    const verdict = await this.assess?.({
      surface: 'security_report',
      kind: 'contact',
      body: request.body,
      email: input.reporterEmail ?? undefined,
      texts: [input.title, input.body],
      ip: request.ip,
      acceptLanguage: request.acceptLanguage,
      ...(input.language === null ? {} : { pageLocale: input.language }),
      offerChallenge: false,
      correlationId: request.correlationId,
    });
    if (verdict?.decision === 'blocked') {
      if (verdict.retryAfterSeconds !== undefined) {
        return { kind: 'rate_limited', retryAfterSeconds: verdict.retryAfterSeconds };
      }
      return { kind: 'accepted', reference: newSecurityReportReference() };
    }
    // This door cannot render a challenge (offerChallenge: false), so one is a hold for a person.
    const decision =
      verdict === undefined
        ? 'allow'
        : verdict.decision === 'challenge'
          ? 'hold'
          : verdict.decision;

    const at = this.now();
    const id = uuidv7();
    const reference = newSecurityReportReference();
    await this.store.insert(
      {
        id,
        reference,
        reporterEmailEnc: this.seal(input.reporterEmail, id),
        reporterName: input.reporterName,
        title: input.title,
        body: input.body,
        severityClaimed: input.severityClaimed,
        status: 'new',
        riskDecision: decision,
        language: input.language,
        createdAt: at,
        updatedAt: at,
        acknowledgedAt: null,
        resolvedAt: null,
        creditName: null,
        creditPublic: false,
      },
      request.correlationId,
    );
    if (decision === 'allow' && input.reporterEmail !== null) {
      await this.acknowledge(id, input.reporterEmail, reference, input.language, request);
    }
    return { kind: 'accepted', reference };
  }

  // ── Platform ───────────────────────────────────────────────────────────────

  async list(
    query: { readonly status?: unknown; readonly limit?: unknown },
    context: PlatformRequestContext,
  ): Promise<readonly SecurityReportSummary[]> {
    const status =
      query.status === undefined || query.status === ''
        ? undefined
        : (SECURITY_REPORT_STATUSES as readonly unknown[]).includes(query.status)
          ? (query.status as SecurityReportStatus)
          : null;
    const limit = query.limit === undefined ? DEFAULT_PAGE : Number(query.limit);
    const limitOk = Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE;
    if (status === null || !limitOk) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        ...(status === null
          ? [{ field: 'status', message: `one of ${SECURITY_REPORT_STATUSES.join(', ')}` }]
          : []),
        ...(limitOk ? [] : [{ field: 'limit', message: `an integer 1–${MAX_PAGE}` }]),
      ]);
    }
    const rows = await this.store.list(
      { ...(status === undefined ? {} : { status }), limit },
      context.correlationId,
    );
    return rows.map(toSummary);
  }

  async get(
    actor: PlatformAdminActor,
    id: string,
    context: PlatformRequestContext,
  ): Promise<SecurityReportDetail> {
    if (!ID_SHAPE.test(id)) throw notFound();
    const row = await this.store.findAudited(
      id,
      (found) =>
        platformAuditFor(actor, context, {
          action: 'platform.security_report_viewed',
          targetType: 'platform',
          targetId: found.id,
          targetLabel: found.reference,
          reason: null,
        }),
      context.correlationId,
    );
    if (row === null) throw notFound();
    return this.detail(row);
  }

  async update(
    actor: PlatformAdminActor,
    id: string,
    body: Readonly<Record<string, unknown>>,
    context: PlatformRequestContext,
  ): Promise<SecurityReportDetail> {
    const update = parseSecurityReportUpdate(body);
    if (!ID_SHAPE.test(id)) throw notFound();
    const at = this.now();
    const row = await this.store.updateAudited(
      id,
      (found) => {
        const status = update.status ?? (found.status as SecurityReportStatus);
        const next = {
          status,
          creditName: update.creditName === undefined ? found.creditName : update.creditName,
          creditPublic: update.creditPublic ?? found.creditPublic,
          resolvedAt: isResolved(status) ? (found.resolvedAt ?? at) : null,
          updatedAt: at,
        };
        return {
          next,
          audit: platformAuditFor(actor, context, {
            action: 'platform.security_report_updated',
            targetType: 'platform',
            targetId: found.id,
            targetLabel: found.reference,
            reason: null,
            beforeJson: JSON.stringify({
              status: found.status,
              creditName: found.creditName,
              creditPublic: found.creditPublic,
            }),
            afterJson: JSON.stringify({
              status: next.status,
              creditName: next.creditName,
              creditPublic: next.creditPublic,
            }),
          }),
        };
      },
      context.correlationId,
    );
    if (row === null) throw notFound();
    return this.detail(row);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Encrypt the address, or store nothing when the host is keyless — never plaintext. */
  private seal(email: string | null, id: string): string | null {
    if (email === null || !this.cipher.enabled) return null;
    try {
      return this.cipher.encrypt(email, { purpose: CIPHER_PURPOSE, ownerId: id });
    } catch {
      return null;
    }
  }

  private open(envelope: string | null, id: string): string | null {
    if (envelope === null) return null;
    try {
      return this.cipher.decrypt(envelope, { purpose: CIPHER_PURPOSE, ownerId: id });
    } catch {
      return null;
    }
  }

  private async acknowledge(
    id: string,
    to: string,
    reference: string,
    language: 'en' | 'ar' | null,
    request: SecurityReportSubmitRequest,
  ): Promise<void> {
    if (this.mailer === null) return;
    try {
      await this.mailer.send(composeAcknowledgement(to, reference, language));
      await this.store.markAcknowledged(id, this.now(), request.correlationId);
    } catch {
      // The report is stored; the reporter still has the reference on screen.
    }
  }

  private detail(row: SecurityReportRecord): SecurityReportDetail {
    return {
      ...toSummary(row),
      body: row.body,
      reporterName: row.reporterName,
      reporterEmail: this.open(row.reporterEmailEnc, row.id),
      language: row.language,
      acknowledgedAt: iso(row.acknowledgedAt),
      creditName: row.creditName,
      creditPublic: row.creditPublic,
    };
  }
}
