import {
  authorize,
  buildExport,
  EXPORT_KINDS,
  EXPORT_TARGETS,
  isExportKind,
  isExportTarget,
  uuidv7,
} from '@tmanage/domain';
import type { Capability, ExportKind, ExportTarget, Principal } from '@tmanage/domain';
import type { FinanceExportRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import { verifyReauthToken } from '../identity/reauth-token.js';
import type { FinanceExportsRepository } from './finance-exports.repository.js';
import { manifestJson, sha256Hex, zipStore } from './zip-store.js';
import type { ZipEntry } from './zip-store.js';

/**
 * 52-11 — accounting export by file. `POST …/finance/exports` renders one target's files for a
 * period into a STORE zip (README EN/AR + `manifest.json` + the CSVs) and returns it once; nothing
 * is stored but the history row (counts + manifest SHA-256). `GET …/finance/exports` lists the
 * newest 50 runs.
 *
 * - Capability: `invoice.export` → `finance.manage` plus a fresh step-up (`x-reauth-token`, the
 *   same token `invoice.send` takes); the list → `finance.view`. Internal members only.
 * - ONE transaction: the reads, the caps (> 5,000 invoices → 413), the duplicate guard (an invoice
 *   already exported and no `reexport` → 409 `already_exported`), the history row, the exported
 *   marks on the invoices and the `finance.exported` audit row (ids, target, counts — no content).
 *   The audit row commits with the marks, before a byte leaves; if it cannot be written the export
 *   fails closed.
 * - Invoice-level data only (the repository's explicit selections); the submitter's display name
 *   only with kind `expenses`.
 */

export const FINANCE_EXPORT_MAX_INVOICES = 5_000;
/** Ceiling for credit notes, payments and expenses in one run (each). */
export const FINANCE_EXPORT_MAX_ROWS = 20_000;
export const FINANCE_EXPORT_MAX_MONTHS = 13;
export const FINANCE_EXPORT_LIST_LIMIT = 50;

const FINANCE_MANAGE: Capability = 'finance.manage';
const FINANCE_VIEW: Capability = 'finance.view';
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;

export interface FinanceExportsServiceOptions {
  readonly database: TenantDatabase;
  readonly repository: FinanceExportsRepository;
  readonly audit: Pick<AuditService, 'record'>;
  readonly sessionSecret?: string;
  readonly now?: () => Date;
}

export interface ExportRequest {
  readonly target: ExportTarget;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly kinds: readonly ExportKind[];
  readonly latinOnly: boolean;
  readonly reexport: boolean;
}

export interface StepUpMeta {
  readonly reauthToken?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface FinanceExportDownload {
  readonly exportId: string;
  readonly filename: string;
  readonly zip: Buffer;
  readonly manifestSha256: string;
}

export interface FinanceExportView {
  readonly id: string;
  readonly target: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly kinds: readonly string[];
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly manifestSha256: string;
  readonly latinOnly: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

const invalid = (field: string, message: string): ApiError =>
  new ApiError(400, 'validation_failed', 'The export request is invalid', [{ field, message }]);
const forbidden = (code: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, code);
const tooLarge = (field: string): ApiError =>
  new ApiError(
    413,
    'validation_failed',
    'export_too_large',
    [{ field, message: 'export_too_large' }],
    'finance_export_row_cap',
  );

function validDay(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) throw invalid(field, 'must be YYYY-MM-DD');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw invalid(field, 'must be a real date');
  }
  return value;
}

function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}

function nextDay(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000);
}

/** Validate `{target, periodStart, periodEnd, kinds[], latinOnly?, reexport?}`. */
export function validateExportRequest(raw: unknown): ExportRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('body', 'must be an object');
  }
  const body = raw as Record<string, unknown>;
  if (!isExportTarget(body['target'])) {
    throw invalid('target', `must be one of ${EXPORT_TARGETS.join(', ')}`);
  }
  const periodStart = validDay(body['periodStart'], 'periodStart');
  const periodEnd = validDay(body['periodEnd'], 'periodEnd');
  if (periodEnd < periodStart) throw invalid('periodEnd', 'must not be before periodStart');
  if (periodEnd >= addMonths(periodStart, FINANCE_EXPORT_MAX_MONTHS)) {
    throw invalid('periodEnd', `the period must not exceed ${FINANCE_EXPORT_MAX_MONTHS} months`);
  }
  const kindsRaw = body['kinds'];
  if (!Array.isArray(kindsRaw) || kindsRaw.length === 0 || !kindsRaw.every(isExportKind)) {
    throw invalid('kinds', `must list one or more of ${EXPORT_KINDS.join(', ')}`);
  }
  const kinds = EXPORT_KINDS.filter((kind) => kindsRaw.includes(kind));
  for (const flag of ['latinOnly', 'reexport'] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== 'boolean') {
      throw invalid(flag, 'must be a boolean');
    }
  }
  return {
    target: body['target'],
    periodStart,
    periodEnd,
    kinds,
    latinOnly: body['latinOnly'] === true,
    reexport: body['reexport'] === true,
  };
}

function toView(row: FinanceExportRow): FinanceExportView {
  let rowCounts: Record<string, number> = {};
  try {
    rowCounts = JSON.parse(row.rowCountsJson) as Record<string, number>;
  } catch {
    rowCounts = {};
  }
  return {
    id: row.id,
    target: row.target,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    kinds: row.kinds === '' ? [] : row.kinds.split(','),
    rowCounts,
    manifestSha256: row.manifestSha256,
    latinOnly: row.latinOnly,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class FinanceExportsService {
  private readonly now: () => Date;

  constructor(private readonly options: FinanceExportsServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async list(
    context: TenantContext,
    principal: Principal,
  ): Promise<{ readonly exports: readonly FinanceExportView[] }> {
    this.require(principal, context, FINANCE_VIEW, 'finance_export.view');
    const rows = await this.options.database.read(context, (runner) =>
      this.options.repository.listExports(
        runner,
        context.organizationId,
        FINANCE_EXPORT_LIST_LIMIT,
      ),
    );
    return { exports: rows.map(toView) };
  }

  async create(
    context: TenantContext,
    principal: Principal,
    body: unknown,
    meta: StepUpMeta,
  ): Promise<FinanceExportDownload> {
    this.require(principal, context, FINANCE_MANAGE, 'finance_export.manage');
    const request = validateExportRequest(body);
    if (!this.stepUpFresh(context, meta)) {
      throw new ApiError(
        403,
        'reauthentication_required',
        'Confirm your password to download an accounting export.',
        undefined,
        'finance_export.step_up',
      );
    }
    const org = context.organizationId;
    const repo = this.options.repository;
    const at = this.now();
    const exportId = uuidv7();
    const { target, periodStart, periodEnd, kinds } = request;
    const wants = (kind: ExportKind): boolean => kinds.includes(kind);

    return this.options.database.transaction(context, async (tx) => {
      const needInvoices = wants('invoices') || wants('customers');
      const invoiceRows = needInvoices
        ? await repo.invoices(tx, org, periodStart, periodEnd, FINANCE_EXPORT_MAX_INVOICES + 1)
        : [];
      if (invoiceRows.length > FINANCE_EXPORT_MAX_INVOICES) throw tooLarge('invoices');
      if (wants('invoices') && !request.reexport) {
        const already = invoiceRows.filter((row) => row.exportedAt !== null).length;
        if (already > 0) {
          throw new ApiError(409, 'conflict', 'already_exported', [
            { field: 'already_exported', message: String(already) },
          ]);
        }
      }
      const lines = wants('invoices')
        ? await repo.invoiceLines(
            tx,
            org,
            invoiceRows.map((row) => row.id),
          )
        : new Map();
      const invoices = wants('invoices')
        ? invoiceRows.map(({ exportedAt: _exportedAt, ...row }) => ({
            ...row,
            lines: lines.get(row.id) ?? [],
          }))
        : [];
      const limit = FINANCE_EXPORT_MAX_ROWS + 1;
      const creditNotes = wants('credit_notes')
        ? await repo.creditNotes(
            tx,
            org,
            new Date(`${periodStart}T00:00:00Z`),
            nextDay(periodEnd),
            limit,
          )
        : [];
      const payments = wants('payments')
        ? await repo.payments(tx, org, periodStart, periodEnd, limit)
        : [];
      const expenses = wants('expenses')
        ? await repo.expenses(tx, org, periodStart, periodEnd, limit)
        : [];
      if (creditNotes.length > FINANCE_EXPORT_MAX_ROWS) throw tooLarge('credit_notes');
      if (payments.length > FINANCE_EXPORT_MAX_ROWS) throw tooLarge('payments');
      if (expenses.length > FINANCE_EXPORT_MAX_ROWS) throw tooLarge('expenses');
      const customers = wants('customers')
        ? await repo.customers(tx, org, [...new Set(invoiceRows.map((row) => row.customerId))])
        : [];

      const built = buildExport({
        target,
        kinds,
        invoices,
        creditNotes,
        payments,
        customers,
        expenses,
        latinOnly: request.latinOnly,
        periodStart,
        periodEnd,
      });
      const content: ZipEntry[] = [
        { name: built.readme.name, data: Buffer.from(built.readme.text, 'utf8') },
        ...built.files.map((file) => ({ name: file.name, data: Buffer.from(file.text, 'utf8') })),
      ];
      const manifest = manifestJson(content, {
        exportId,
        target,
        periodStart,
        periodEnd,
        createdAt: at.toISOString(),
      });
      const manifestSha256 = sha256Hex(manifest);
      const zip = zipStore(
        [...content, { name: 'manifest.json', data: Buffer.from(manifest) }],
        at,
      );

      await repo.insertExport(tx, {
        id: exportId,
        organizationId: org,
        target,
        periodStart,
        periodEnd,
        kinds: kinds.join(','),
        rowCountsJson: JSON.stringify(built.rowCounts),
        manifestSha256,
        latinOnly: request.latinOnly,
        createdBy: context.userId,
        createdAt: at,
      });
      if (wants('invoices') && invoices.length > 0) {
        await repo.markInvoicesExported(
          tx,
          org,
          invoices.map((row) => row.id),
          at,
          target,
        );
      }
      await this.options.audit.record(tx, context, {
        action: 'finance.exported',
        result: 'allowed',
        objectId: exportId,
        actorUserId: context.userId,
        metadata: {
          export_id: exportId,
          target,
          period_start: periodStart,
          period_end: periodEnd,
          kinds: kinds.join(':'),
          latin_only: request.latinOnly,
          reexport: request.reexport,
          ...Object.fromEntries(
            Object.entries(built.rowCounts).map(([kind, count]) => [`${kind}_count`, count]),
          ),
        },
        changes: [],
      });
      return {
        exportId,
        filename: `tmanage-${target}-${periodStart}_${periodEnd}.zip`,
        zip,
        manifestSha256,
      };
    });
  }

  private stepUpFresh(context: TenantContext, meta: StepUpMeta): boolean {
    const secret = this.options.sessionSecret;
    if (secret === undefined || meta.reauthToken === undefined || meta.sessionId === undefined) {
      return false;
    }
    const verified = verifyReauthToken(meta.reauthToken, secret, this.now().getTime());
    return (
      verified.ok &&
      verified.claims.userId === context.userId &&
      verified.claims.sessionId === meta.sessionId
    );
  }

  private require(
    principal: Principal,
    context: TenantContext,
    capability: Capability,
    code: string,
  ): void {
    if (principal.kind !== 'internal') throw forbidden(`${code}.internal_only`);
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) throw forbidden(code);
  }
}
