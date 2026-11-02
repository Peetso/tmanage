import {
  authorize,
  hasCapability,
  isCustomRoleId,
  isInternalRole,
  parseCustomRoleCapabilities,
  toCsv,
  uuidv7,
} from '@tmanage/domain';
import type { AuditAction, Capability, Principal } from '@tmanage/domain';
import type { ExpenseRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsRepository } from '../inbox/notifications.repository.js';
import {
  AUTO_APPROVE_SETTING_KEY,
  DUPLICATE_WINDOW_DAYS,
  EXPENSE_PAGE,
  MAX_EXPORT_ROWS,
  autoApproves,
  fxRateMissing,
  nextExpenseState,
  noteText,
  parseThreshold,
  refuseTransition,
  toBaseMinor,
  validateExpense,
  validateExpensePatch,
  validateQuery,
} from './expenses-rules.js';
import type { ExpenseEvent, ExpenseInput } from './expenses-rules.js';
import type {
  ApproverCandidate,
  ExpenseChange,
  ExpensesRepository,
} from './expenses.repository.js';
import { defaultProfile } from './finance-rules.js';
import type { FinanceRepository } from './finance.repository.js';
import { FINANCE_MANAGE } from './finance.service.js';
import { REDACTED } from './rates-rules.js';
import type { RatesRepository } from './rates.repository.js';

/**
 * 52-07 — expenses: record, edit, submit, approve / reject, delete an own draft, list, CSV export.
 *
 * Capability stand-ins (see `expenses-rules.ts`): submit = `work.read` + internal; approve =
 * `project.manage` on the expense's project (`finance.manage` when it has none), never one's own;
 * view all + export = `finance.manage`. Org-internal: no portal route, so cost and markup never
 * reach a client principal. `locked_at` is set only by a future 52-09 path; a locked row is
 * refused here (409) and at the engine (0292 triggers).
 */

export const EXPENSE_SUBMIT: Capability = 'work.read';
export const EXPENSE_APPROVE: Capability = 'project.manage';

export interface ExpenseView {
  readonly id: string;
  readonly projectId: string | null;
  readonly membershipId: string;
  readonly spentOn: string;
  readonly category: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly amountBaseMinor: number | null;
  readonly fxRate: string | null;
  readonly taxBp: number;
  readonly billable: boolean;
  readonly markupBp: number;
  readonly note: string | null;
  readonly receiptFileAssetId: string | null;
  readonly state: string;
  readonly approvedAt: string | null;
  readonly rejectedReason: string | null;
  readonly locked: boolean;
  readonly version: number;
  readonly updatedAt: string;
  /** Only on an approver's read of somebody else's expense. */
  readonly possibleDuplicateOf?: string | null;
}

export interface ExpensePage {
  readonly expenses: readonly ExpenseView[];
  readonly nextCursor: string | null;
}

export interface ExpensesServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: ExpensesRepository;
  readonly finance: Pick<FinanceRepository, 'profile' | 'organization' | 'exchangeRates'>;
  readonly rates: Pick<RatesRepository, 'projectPricing'>;
  readonly notifications: Pick<NotificationsRepository, 'insertForRecipient'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const DAY_MS = 86_400_000;

export function expenseView(row: ExpenseRow): ExpenseView {
  return {
    id: row.id,
    projectId: row.projectId,
    membershipId: row.membershipId,
    spentOn: row.spentOn,
    category: row.category,
    amountMinor: Number(row.amountMinor),
    currency: row.currency,
    amountBaseMinor: row.amountBaseMinor === null ? null : Number(row.amountBaseMinor),
    fxRate: row.fxRate,
    taxBp: row.taxBp,
    billable: row.billable,
    markupBp: row.markupBp,
    note: row.note,
    receiptFileAssetId: row.receiptFileAssetId,
    state: row.state,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedReason: row.rejectedReason,
    locked: row.lockedAt !== null,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Of the candidates, the users whose role (built-in or custom) holds `capability`. */
export function holders(
  candidates: readonly ApproverCandidate[],
  capability: Capability,
): string[] {
  const out = new Set<string>();
  for (const c of candidates) {
    const holds = isInternalRole(c.role)
      ? hasCapability(c.role, capability)
      : isCustomRoleId(c.role.toLowerCase()) &&
        c.customCapabilitiesJson !== null &&
        parseCustomRoleCapabilities(c.customCapabilitiesJson).includes(capability);
    if (holds) out.add(c.userId);
  }
  return [...out];
}

const CSV_HEADER = [
  'id',
  'spent_on',
  'membership_id',
  'project_id',
  'category',
  'amount_minor',
  'currency',
  'amount_base_minor',
  'fx_rate',
  'tax_bp',
  'billable',
  'markup_bp',
  'state',
  'approved_at',
  'note',
] as const;

/** The export shape. A note leaves only on the exporter's own rows. */
export function expensesCsv(rows: readonly ExpenseRow[], exporterMembershipId: string): string {
  return toCsv(
    rows.map((row) => [
      row.id,
      row.spentOn,
      row.membershipId,
      row.projectId,
      row.category,
      Number(row.amountMinor),
      row.currency,
      row.amountBaseMinor === null ? null : Number(row.amountBaseMinor),
      row.fxRate,
      row.taxBp,
      row.billable,
      row.markupBp,
      row.state,
      row.approvedAt?.toISOString() ?? null,
      row.membershipId === exporterMembershipId ? row.note : null,
    ]),
    CSV_HEADER,
    { bom: true },
  );
}

const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);
const forbidden = (code: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, code);

export class ExpensesService {
  private readonly now: () => Date;

  constructor(private readonly options: ExpensesServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async create(context: TenantContext, principal: Principal, body: unknown): Promise<ExpenseView> {
    this.requireInternal(principal);
    const input = validateExpense(body, this.allows(principal, context, FINANCE_MANAGE, null));
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const project = await this.resolveProject(tx, context, principal, input.projectId);
      const receiptVersionId = await this.resolveReceipt(tx, context, input.receiptFileAssetId);
      const fx = await this.toBase(tx, context, input.amountMinor, input.currency, input.spentOn);
      const row: ExpenseRow = {
        id: uuidv7(),
        organizationId: context.organizationId,
        projectId: input.projectId,
        clientOrganizationId: project?.clientOrgId ?? null,
        membershipId: context.membershipId,
        spentOn: input.spentOn,
        category: input.category,
        amountMinor: input.amountMinor,
        currency: input.currency,
        amountBaseMinor: fx?.baseMinor ?? null,
        fxRate: fx?.rate ?? null,
        taxBp: input.taxBp,
        billable: input.billable ?? project?.billableDefault ?? false,
        markupBp: input.markupBp,
        note: input.note,
        receiptFileAssetId: input.receiptFileAssetId,
        receiptFileVersionId: receiptVersionId,
        state: 'draft',
        approvalId: null,
        approvedBy: null,
        approvedAt: null,
        rejectedReason: null,
        invoiceLineId: null,
        lockedAt: null,
        version: 1,
        createdAt: at,
        updatedAt: at,
      };
      await this.options.repository.insert(tx, row);
      await this.audited(tx, context, 'expense.created', row.id, { category: row.category }, [
        { field: 'amountMinor', before: null, after: row.amountMinor },
        { field: 'currency', before: null, after: row.currency },
        { field: 'receiptFileAssetId', before: null, after: row.receiptFileAssetId },
        { field: 'note', before: null, after: row.note === null ? null : REDACTED },
      ]);
      const final = input.submit ? await this.submitRow(tx, context, row, at) : row;
      return expenseView(final);
    });
  }

  async list(
    context: TenantContext,
    principal: Principal,
    query: Record<string, unknown>,
  ): Promise<ExpensePage> {
    this.requireInternal(principal);
    const filter = validateQuery(query);
    const all =
      this.allows(principal, context, FINANCE_MANAGE, null) ||
      (filter.projectId !== null &&
        this.allows(principal, context, EXPENSE_APPROVE, filter.projectId));
    const rows = await this.options.database.read(context, (r) =>
      this.options.repository.list(
        r,
        context.organizationId,
        filter,
        all ? null : context.membershipId,
        EXPENSE_PAGE + 1,
      ),
    );
    const page = rows.slice(0, EXPENSE_PAGE);
    return {
      expenses: page.map(expenseView),
      nextCursor: rows.length > EXPENSE_PAGE ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(context: TenantContext, principal: Principal, id: string): Promise<ExpenseView> {
    this.requireInternal(principal);
    return this.options.database.read(context, async (r) => {
      const row = await this.options.repository.find(r, context.organizationId, id);
      if (row === null) throw notFound();
      const own = row.membershipId === context.membershipId;
      const approver = this.mayApprove(principal, context, row);
      if (!own && !approver && !this.allows(principal, context, FINANCE_MANAGE, null))
        throw notFound();
      if (own || !approver || row.receiptFileVersionId === null) return expenseView(row);
      const since = new Date(this.now().getTime() - DUPLICATE_WINDOW_DAYS * DAY_MS);
      const duplicate = await this.options.repository.duplicateOf(
        r,
        context.organizationId,
        row.id,
        row.receiptFileVersionId,
        since,
      );
      return { ...expenseView(row), possibleDuplicateOf: duplicate };
    });
  }

  async update(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<ExpenseView> {
    this.requireInternal(principal);
    const patch = validateExpensePatch(body, this.allows(principal, context, FINANCE_MANAGE, null));
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.ownRow(tx, context, id, 'edit');
      const next = { ...this.inputOf(row), ...patch };
      const project =
        patch.projectId === undefined
          ? null
          : await this.resolveProject(tx, context, principal, next.projectId);
      const change: ExpenseChange = { updatedAt: at };
      if (patch.projectId !== undefined) {
        change.projectId = next.projectId;
        change.clientOrganizationId = project?.clientOrgId ?? null;
      }
      if (patch.receiptFileAssetId !== undefined) {
        change.receiptFileAssetId = next.receiptFileAssetId;
        change.receiptFileVersionId = await this.resolveReceipt(
          tx,
          context,
          next.receiptFileAssetId,
        );
      }
      for (const key of ['spentOn', 'category', 'markupBp', 'taxBp', 'note'] as const)
        if (patch[key] !== undefined) Object.assign(change, { [key]: next[key] });
      if (patch.billable !== undefined) change.billable = next.billable ?? false;
      const moneyChanged =
        next.amountMinor !== Number(row.amountMinor) ||
        next.currency !== row.currency ||
        next.spentOn !== row.spentOn;
      if (moneyChanged) {
        const fx = await this.toBase(tx, context, next.amountMinor, next.currency, next.spentOn);
        if (fx === null && row.state === 'submitted')
          throw fxRateMissing(next.currency, await this.baseCurrency(tx, context));
        Object.assign(change, {
          amountMinor: next.amountMinor,
          currency: next.currency,
          amountBaseMinor: fx?.baseMinor ?? null,
          fxRate: fx?.rate ?? null,
        });
        // After submit, an amount edit is a new version the approver decides on again.
        if (row.state !== 'draft') change.version = row.version + 1;
      }
      await this.options.repository.update(tx, context.organizationId, row.id, change);
      const changes: { field: string; before: unknown; after: unknown }[] = [];
      if (moneyChanged) {
        changes.push({
          field: 'amountMinor',
          before: Number(row.amountMinor),
          after: next.amountMinor,
        });
        changes.push({ field: 'currency', before: row.currency, after: next.currency });
      }
      if (patch.receiptFileAssetId !== undefined)
        changes.push({
          field: 'receiptFileAssetId',
          before: row.receiptFileAssetId,
          after: next.receiptFileAssetId,
        });
      if (patch.note !== undefined)
        changes.push({ field: 'note', before: REDACTED, after: REDACTED });
      await this.audited(
        tx,
        context,
        'expense.updated',
        row.id,
        { version_bumped: change.version !== undefined },
        changes,
      );
      return expenseView(await this.require(tx, context, row.id));
    });
  }

  async remove(context: TenantContext, principal: Principal, id: string): Promise<void> {
    this.requireInternal(principal);
    await this.options.database.transaction(context, async (tx) => {
      const row = await this.ownRow(tx, context, id, 'delete');
      await this.options.repository.remove(tx, context.organizationId, row.id);
      await this.audited(tx, context, 'expense.deleted', row.id, {}, []);
    });
  }

  async submit(context: TenantContext, principal: Principal, id: string): Promise<ExpenseView> {
    this.requireInternal(principal);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.ownRow(tx, context, id, 'submit');
      return expenseView(await this.submitRow(tx, context, row, at));
    });
  }

  async approve(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<ExpenseView> {
    return this.decide(context, principal, id, 'approve', body);
  }

  async reject(
    context: TenantContext,
    principal: Principal,
    id: string,
    body: unknown,
  ): Promise<ExpenseView> {
    return this.decide(context, principal, id, 'reject', body);
  }

  /** `finance.manage`. Audited before the bytes leave (fails closed with the transaction). */
  async exportCsv(
    context: TenantContext,
    principal: Principal,
    query: Record<string, unknown>,
  ): Promise<string> {
    this.requireInternal(principal);
    if (!this.allows(principal, context, FINANCE_MANAGE, null)) throw forbidden('expense.export');
    const filter = { ...validateQuery(query), cursor: null };
    return this.options.database.transaction(context, async (tx) => {
      const rows = await this.options.repository.list(
        tx,
        context.organizationId,
        filter,
        null,
        MAX_EXPORT_ROWS + 1,
      );
      if (rows.length > MAX_EXPORT_ROWS)
        throw new ApiError(422, 'validation_failed', 'Too many expenses to export at once.', [
          { field: 'period', message: `narrow the filter to at most ${MAX_EXPORT_ROWS} rows` },
        ]);
      await this.audited(
        tx,
        context,
        'expense.exported',
        context.organizationId,
        {
          export_kind: 'expenses',
          row_count: rows.length,
          filter_period: filter.from !== null,
          filter_project: filter.projectId !== null,
          filter_state: filter.state ?? 'all',
        },
        [],
      );
      return expensesCsv(rows, context.membershipId);
    });
  }

  // ---- internals ----

  private async decide(
    context: TenantContext,
    principal: Principal,
    id: string,
    event: 'approve' | 'reject',
    body: unknown,
  ): Promise<ExpenseView> {
    this.requireInternal(principal);
    const raw =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['note'] : null;
    const note = noteText(raw, 'note', event === 'reject' ? 3 : 0);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const row = await this.require(tx, context, id, true);
      if (!this.mayApprove(principal, context, row)) throw notFound();
      if (row.membershipId === context.membershipId)
        throw new ApiError(
          403,
          'forbidden',
          'You cannot approve or reject your own expense.',
          [{ field: 'expense', message: 'cannot_approve_own' }],
          'cannot_approve_own',
        );
      this.assertUnlocked(row);
      const state = nextExpenseState(row.state, event);
      if (state === null) throw refuseTransition(row.state, event);
      await this.options.repository.update(tx, context.organizationId, row.id, {
        state,
        updatedAt: at,
        ...(event === 'approve'
          ? { approvedBy: context.membershipId, approvedAt: at, rejectedReason: null }
          : { rejectedReason: note, approvedBy: null, approvedAt: null }),
      });
      await this.notifyMember(
        tx,
        context,
        row,
        event === 'approve' ? 'expense.approved' : 'expense.rejected',
        at,
      );
      await this.audited(
        tx,
        context,
        event === 'approve' ? 'expense.approved' : 'expense.rejected',
        row.id,
        { auto: false, version: row.version },
        [
          { field: 'state', before: row.state, after: state },
          ...(note === null ? [] : [{ field: 'note', before: null, after: REDACTED }]),
        ],
      );
      return expenseView(await this.require(tx, context, row.id));
    });
  }

  /** draft|rejected → submitted, or straight to approved under the org threshold. */
  private async submitRow(
    tx: TenantQueryRunner,
    context: TenantContext,
    row: ExpenseRow,
    at: Date,
  ): Promise<ExpenseRow> {
    this.assertUnlocked(row);
    if (nextExpenseState(row.state, 'submit') === null) throw refuseTransition(row.state, 'submit');
    // A rate added since the draft was saved counts: convert again at submit.
    const fx = await this.toBase(tx, context, Number(row.amountMinor), row.currency, row.spentOn);
    if (fx === null) {
      const base = await this.baseCurrency(tx, context);
      throw fxRateMissing(row.currency, base);
    }
    const repo = this.options.repository;
    const threshold = parseThreshold(
      await repo.setting(tx, context.organizationId, AUTO_APPROVE_SETTING_KEY),
    );
    const auto = autoApproves(fx.baseMinor, threshold);
    const change: ExpenseChange = {
      state: auto ? 'approved' : 'submitted',
      amountBaseMinor: fx.baseMinor,
      fxRate: fx.rate,
      rejectedReason: null,
      approvedBy: null,
      approvedAt: auto ? at : null,
      updatedAt: at,
    };
    await repo.update(tx, context.organizationId, row.id, change);
    await this.audited(tx, context, 'expense.submitted', row.id, { auto_approved: auto }, [
      { field: 'state', before: row.state, after: 'submitted' },
      { field: 'amountBaseMinor', before: row.amountBaseMinor, after: fx.baseMinor },
    ]);
    if (auto) {
      await this.audited(
        tx,
        context,
        'expense.approved',
        row.id,
        { auto: true, version: row.version },
        [{ field: 'state', before: 'submitted', after: 'approved' }],
      );
    } else {
      const capability = row.projectId === null ? FINANCE_MANAGE : EXPENSE_APPROVE;
      const approvers = holders(
        await repo.approverCandidates(tx, context.organizationId, row.projectId),
        capability,
      ).filter((userId) => userId !== context.userId);
      for (const recipientUserId of approvers) {
        await this.options.notifications.insertForRecipient(tx, context, {
          recipientUserId,
          type: 'expense.submitted',
          objectType: 'expense',
          objectId: row.id,
          dedupeKey: `expense.submitted:${row.id}:${row.version}:${at.getTime()}`,
        });
      }
    }
    return { ...row, ...change } as ExpenseRow;
  }

  private async notifyMember(
    tx: TenantQueryRunner,
    context: TenantContext,
    row: ExpenseRow,
    type: string,
    at: Date,
  ): Promise<void> {
    const userId = await this.options.repository.membershipUser(
      tx,
      context.organizationId,
      row.membershipId,
    );
    if (userId === null) return;
    await this.options.notifications.insertForRecipient(tx, context, {
      recipientUserId: userId,
      type,
      objectType: 'expense',
      objectId: row.id,
      dedupeKey: `${type}:${row.id}:${row.version}:${at.getTime()}`,
    });
  }

  /** The caller's own row, unlocked, in a state that allows `event`. */
  private async ownRow(
    tx: TenantQueryRunner,
    context: TenantContext,
    id: string,
    event: ExpenseEvent,
  ): Promise<ExpenseRow> {
    const row = await this.require(tx, context, id, true);
    if (row.membershipId !== context.membershipId) throw notFound();
    this.assertUnlocked(row);
    if (nextExpenseState(row.state, event) === null) throw refuseTransition(row.state, event);
    return row;
  }

  private assertUnlocked(row: ExpenseRow): void {
    if (row.lockedAt !== null)
      throw new ApiError(409, 'conflict', 'This expense is locked.', [
        { field: 'state', message: 'expense_locked' },
      ]);
  }

  private inputOf(row: ExpenseRow): ExpenseInput {
    return {
      projectId: row.projectId,
      spentOn: row.spentOn,
      category: row.category as ExpenseInput['category'],
      amountMinor: Number(row.amountMinor),
      currency: row.currency,
      billable: row.billable,
      markupBp: row.markupBp,
      taxBp: row.taxBp,
      note: row.note,
      receiptFileAssetId: row.receiptFileAssetId,
    };
  }

  /** Tenant-scoped 404, and the caller must reach the project (`work.read`). */
  private async resolveProject(
    tx: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    projectId: string | null,
  ): Promise<{ readonly billableDefault: boolean; readonly clientOrgId: string | null } | null> {
    if (projectId === null) return null;
    const project = await this.options.rates.projectPricing(tx, context.organizationId, projectId);
    if (project === null || !this.allows(principal, context, EXPENSE_SUBMIT, projectId))
      throw notFound();
    return project;
  }

  /** The receipt must be this tenant's `expense_receipt` upload, made by the caller. */
  private async resolveReceipt(
    tx: TenantQueryRunner,
    context: TenantContext,
    assetId: string | null,
  ): Promise<string | null> {
    if (assetId === null) return null;
    const asset = await this.options.repository.receiptAsset(tx, context.organizationId, assetId);
    if (
      asset === null ||
      asset.deleted ||
      asset.purpose !== 'expense_receipt' ||
      asset.ownerUserId !== context.userId
    )
      throw notFound();
    return asset.versionId;
  }

  private async baseCurrency(tx: TenantQueryRunner, context: TenantContext): Promise<string> {
    const finance = this.options.finance;
    const profile = await finance.profile(tx, context.organizationId);
    if (profile !== null) return profile.baseCurrency;
    return defaultProfile(await finance.organization(tx, context.organizationId)).baseCurrency;
  }

  /** The base value through the newest manual rate on or before `spentOn`; `null` when none. */
  private async toBase(
    tx: TenantQueryRunner,
    context: TenantContext,
    amountMinor: number,
    currency: string,
    spentOn: string,
  ): Promise<{ readonly baseMinor: number; readonly rate: string | null } | null> {
    const base = await this.baseCurrency(tx, context);
    if (currency === base) return { baseMinor: amountMinor, rate: null };
    const rates = await this.options.finance.exchangeRates(tx, context.organizationId, {
      fromCurrency: currency,
      toCurrency: base,
      limit: 200,
    });
    const rate = rates.find((r) => r.effectiveOn <= spentOn);
    if (rate === undefined) return null;
    return { baseMinor: toBaseMinor(amountMinor, currency, base, rate.rate), rate: rate.rate };
  }

  private async require(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    lock = false,
  ): Promise<ExpenseRow> {
    const row = await this.options.repository.find(runner, context.organizationId, id, lock);
    if (row === null) throw notFound();
    return row;
  }

  private mayApprove(principal: Principal, context: TenantContext, row: ExpenseRow): boolean {
    return row.projectId === null
      ? this.allows(principal, context, FINANCE_MANAGE, null)
      : this.allows(principal, context, EXPENSE_APPROVE, row.projectId);
  }

  private allows(
    principal: Principal,
    context: TenantContext,
    capability: Capability,
    projectId: string | null,
  ): boolean {
    return authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  private requireInternal(principal: Principal): void {
    if (principal.kind !== 'internal') throw forbidden('expense.internal_only');
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    objectId: string | null,
    metadata: Readonly<Record<string, string | number | boolean | null>>,
    changes: readonly {
      readonly field: string;
      readonly before: unknown;
      readonly after: unknown;
    }[],
  ): Promise<void> {
    await this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId,
      actorUserId: context.userId,
      metadata,
      changes,
    });
  }
}
