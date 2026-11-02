import {
  authorize,
  canUseLabel,
  defaultLabelFor,
  DOCUMENT_LABELS,
  isEinvoiceRegime,
  resolvedRegime,
  taxDocumentRuleFor,
  taxNoticeRequired,
} from '@tmanage/domain';
import type { DocumentLabel, EinvoiceRegime, TaxDocumentRule } from '@tmanage/domain';
import type { AuditAction, Capability, Principal } from '@tmanage/domain';
import type {
  OrgExchangeRateRow,
  OrgFinanceProfileRow,
  OrgTaxRateRow,
} from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  currency,
  defaultProfile,
  invalid,
  profileChanges,
  readiness,
  seedTaxRates,
  validateExchangeRate,
  validateProfile,
  validateTaxRate,
} from './finance-rules.js';
import type { FinanceProfileValues, FinanceReadiness, TaxRateInput } from './finance-rules.js';
import type { FinanceRepository } from './finance.repository.js';

/**
 * 52-23 — Settings → Finance, member side: profile, tax rates, manual exchange rates, readiness.
 *
 * Authorized at organization scope on every call. Writes need {@link FINANCE_MANAGE}, reads
 * {@link FINANCE_VIEW}: the real `finance.manage` / `finance.view` keys (52-23 §10), held by
 * exactly the roles that held their former stand-ins — `finance.manage` by Owner / Org Admin /
 * Workspace Admin (was `workspace.manage`), `finance.view` by those and Manager, who drafts quotes
 * and so needs the rates (was `project.manage`). Migration 0264 carried stored custom roles and
 * member overrides across. Both are internal-only; the profile is never part of a client projection.
 */
export const FINANCE_MANAGE: Capability = 'finance.manage';
export const FINANCE_VIEW: Capability = 'finance.view';

const MAX_LIST = 200;

export interface FinanceProfileView extends FinanceProfileValues {
  /** False until the first save; the values are then the defaults. */
  readonly saved: boolean;
  /** 52-28: the country's tax-document rule row (regime = the override when set). */
  readonly taxDocumentRule: TaxDocumentRule;
  readonly version: number;
  readonly updatedAt: string | null;
}

/** 52-28 — `GET …/finance/tax-document-rules`: what the settings row and the drawer show. */
export interface TaxDocumentRulesView {
  readonly country: string;
  readonly vatRegistrationStatus: string;
  readonly regime: EinvoiceRegime;
  readonly defaultLabel: DocumentLabel;
  readonly labels: readonly {
    readonly label: DocumentLabel;
    readonly enabled: boolean;
    readonly reason?: string;
  }[];
  readonly noticeRequired: boolean;
}

/**
 * The rules resolved for a profile. `tax_invoice` is listed as enabled only where it needs no
 * per-document reference; in KSA/EG it is reached through the tax-registration route.
 */
export function taxDocumentRulesFor(profile: FinanceProfileValues): TaxDocumentRulesView {
  const defaultLabel = defaultLabelFor(profile.country, profile.vatRegistrationStatus);
  return {
    country: profile.country,
    vatRegistrationStatus: profile.vatRegistrationStatus,
    regime: resolvedRegime(profile.country, profile.einvoiceRegime),
    defaultLabel,
    labels: DOCUMENT_LABELS.map((label) => {
      const check = canUseLabel({
        country: profile.country,
        vatStatus: profile.vatRegistrationStatus,
        label,
        taxRegistrationRef: null,
      });
      return check.ok ? { label, enabled: true } : { label, enabled: false, reason: check.reason };
    }),
    noticeRequired: taxNoticeRequired(profile.country, defaultLabel),
  };
}

export interface TaxRateView extends TaxRateInput {
  readonly id: string;
  readonly archived: boolean;
  readonly updatedAt: string;
}

export interface ExchangeRateView {
  readonly id: string;
  readonly fromCurrency: string;
  readonly toCurrency: string;
  readonly rate: string;
  readonly effectiveOn: string;
  readonly source: string;
  readonly createdAt: string;
}

export interface FinanceServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: FinanceRepository;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
}

const ER_DUP_ENTRY = 1062;

function isDuplicateKey(error: unknown): boolean {
  const marks = (c: unknown): boolean =>
    typeof c === 'object' &&
    c !== null &&
    ((c as { errno?: number }).errno === ER_DUP_ENTRY ||
      (c as { code?: string }).code === 'ER_DUP_ENTRY');
  return (
    marks(error) ||
    (typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause))
  );
}

function profileValues(row: OrgFinanceProfileRow): FinanceProfileValues {
  return {
    country: row.country,
    baseCurrency: row.baseCurrency,
    taxRegistrationNo: row.taxRegistrationNo,
    taxScheme: row.taxScheme,
    defaultTaxRateBp: row.defaultTaxRateBp,
    legalNameEn: row.legalNameEn,
    legalNameAr: row.legalNameAr,
    addressEn: row.addressEn,
    addressAr: row.addressAr,
    invoicePrefix: row.invoicePrefix,
    quotePrefix: row.quotePrefix,
    creditNotePrefix: row.creditNotePrefix,
    numberingReset: row.numberingReset === 'never' ? 'never' : 'yearly',
    roundingMinutes: row.roundingMinutes,
    weekStart: row.weekStart,
    digits: row.digits === 'arab' ? 'arab' : 'latn',
    showHijri: row.showHijri,
    bankDetailsText: row.bankDetailsText,
    paymentTermsDays: row.paymentTermsDays,
    vatRegistrationStatus:
      row.vatRegistrationStatus === 'registered' ? 'registered' : 'not_registered',
    einvoiceRegime: isEinvoiceRegime(row.einvoiceRegime) ? row.einvoiceRegime : null,
  };
}

function ruleRow(profile: FinanceProfileValues): TaxDocumentRule {
  return {
    ...taxDocumentRuleFor(profile.country),
    regime: resolvedRegime(profile.country, profile.einvoiceRegime),
  };
}

function taxRateView(row: OrgTaxRateRow): TaxRateView {
  return {
    id: row.id,
    code: row.code,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    rateBp: row.rateBp,
    zatcaCategory: row.zatcaCategory,
    isDefault: row.isDefault,
    archived: row.archivedAt !== null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function exchangeRateView(row: OrgExchangeRateRow): ExchangeRateView {
  return {
    id: row.id,
    fromCurrency: row.fromCurrency,
    toCurrency: row.toCurrency,
    rate: row.rate,
    effectiveOn: row.effectiveOn,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

export class FinanceService {
  private readonly now: () => Date;

  constructor(private readonly options: FinanceServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async getProfile(context: TenantContext, principal: Principal): Promise<FinanceProfileView> {
    this.require(principal, context, FINANCE_VIEW);
    return this.options.database.read(context, (r) => this.loadProfile(r, context));
  }

  async updateProfile(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<FinanceProfileView> {
    this.require(principal, context, FINANCE_MANAGE);
    const version = (body as Record<string, unknown> | null)?.['version'];
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      const row = await repo.profile(tx, context.organizationId, true);
      const before = row === null ? await this.defaults(tx, context) : profileValues(row);
      if (row !== null && version !== undefined && version !== row.version) {
        throw new ApiError(409, 'conflict', 'The finance settings were changed by someone else.', [
          { field: 'version', message: 'stale' },
        ]);
      }
      const after = validateProfile(body, before);
      if (row === null) await repo.insertProfile(tx, context.organizationId, after, at);
      else await repo.updateProfile(tx, context.organizationId, after, at);
      await this.audited(
        tx,
        context,
        'finance_profile.updated',
        null,
        profileChanges(before, after),
      );
      return this.loadProfile(tx, context);
    });
  }

  /** Lists the rates; an organization with none gets the four seeds in this same call. */
  async listTaxRates(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly TaxRateView[]> {
    this.require(principal, context, FINANCE_VIEW);
    const existing = await this.options.database.read(context, (r) =>
      this.options.repository.taxRates(r, context.organizationId),
    );
    if (existing.length > 0) return existing.map(taxRateView);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const profile = await this.loadProfile(tx, context);
      for (const seed of seedTaxRates(profile.defaultTaxRateBp)) {
        await this.options.repository.insertTaxRate(tx, context.organizationId, seed, at, true);
      }
      return (await this.options.repository.taxRates(tx, context.organizationId)).map(taxRateView);
    });
  }

  async createTaxRate(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<TaxRateView> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateTaxRate(body);
    const at = this.now();
    try {
      return await this.options.database.transaction(context, async (tx) => {
        const repo = this.options.repository;
        if (input.isDefault) await repo.clearDefaultTaxRate(tx, context.organizationId, at);
        const id = await repo.insertTaxRate(tx, context.organizationId, input, at);
        await this.audited(tx, context, 'tax_rate.created', id, [
          { field: 'code', before: null, after: input.code },
          { field: 'rateBp', before: null, after: input.rateBp },
        ]);
        const row = await repo.taxRate(tx, context.organizationId, id);
        if (row === null) throw new Error('tax rate vanished after insert');
        return taxRateView(row);
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ApiError(409, 'conflict', 'A tax rate with this code already exists.', [
          { field: 'code', message: 'taken' },
        ]);
      }
      throw error;
    }
  }

  /** Change names, rate, category, default flag; `archived: true|false` archives or restores. */
  async updateTaxRate(
    context: TenantContext,
    principal: Principal,
    taxRateId: string,
    body: unknown,
  ): Promise<TaxRateView> {
    this.require(principal, context, FINANCE_MANAGE);
    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      const repo = this.options.repository;
      const row = await repo.taxRate(tx, context.organizationId, taxRateId);
      if (row === null) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      const current = taxRateView(row);
      const input = validateTaxRate(body, current);
      const archivedFlag = (body as Record<string, unknown>)['archived'];
      if (archivedFlag !== undefined && typeof archivedFlag !== 'boolean') {
        throw invalid('archived', 'must be true or false');
      }
      const archived = archivedFlag ?? current.archived;
      if (archived && input.isDefault)
        throw invalid('isDefault', 'an archived rate cannot be the default');
      if (input.isDefault && !current.isDefault)
        await repo.clearDefaultTaxRate(tx, context.organizationId, at);
      await repo.updateTaxRate(
        tx,
        context.organizationId,
        row.id,
        {
          nameEn: input.nameEn,
          nameAr: input.nameAr,
          rateBp: input.rateBp,
          zatcaCategory: input.zatcaCategory,
          isDefault: input.isDefault,
          archivedAt: archived ? (row.archivedAt ?? at) : null,
        },
        at,
      );
      const changes: { field: string; before: unknown; after: unknown }[] = (
        ['nameEn', 'nameAr', 'rateBp', 'zatcaCategory', 'isDefault'] as const
      )
        .filter((key) => current[key] !== input[key])
        .map((key) => ({ field: key, before: current[key], after: input[key] }));
      if (archived !== current.archived)
        changes.push({ field: 'archived', before: current.archived, after: archived });
      await this.audited(
        tx,
        context,
        archived && !current.archived ? 'tax_rate.archived' : 'tax_rate.updated',
        row.id,
        changes,
      );
      const updated = await repo.taxRate(tx, context.organizationId, row.id);
      if (updated === null) throw new Error('tax rate vanished after update');
      return taxRateView(updated);
    });
  }

  async listExchangeRates(
    context: TenantContext,
    principal: Principal,
    query: { readonly from?: unknown; readonly to?: unknown; readonly limit?: unknown },
  ): Promise<readonly ExchangeRateView[]> {
    this.require(principal, context, FINANCE_VIEW);
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST) {
      throw invalid('limit', `must be a whole number from 1 to ${MAX_LIST}`);
    }
    const filter = {
      limit,
      ...(query.from === undefined ? {} : { fromCurrency: currency(query.from, 'from') }),
      ...(query.to === undefined ? {} : { toCurrency: currency(query.to, 'to') }),
    };
    const rows = await this.options.database.read(context, (r) =>
      this.options.repository.exchangeRates(r, context.organizationId, filter),
    );
    return rows.map(exchangeRateView);
  }

  async createExchangeRate(
    context: TenantContext,
    principal: Principal,
    body: unknown,
  ): Promise<ExchangeRateView> {
    this.require(principal, context, FINANCE_MANAGE);
    const input = validateExchangeRate(body);
    const at = this.now();
    try {
      return await this.options.database.transaction(context, async (tx) => {
        const row = await this.options.repository.insertExchangeRate(
          tx,
          context.organizationId,
          input,
          context.userId,
          at,
        );
        await this.audited(tx, context, 'exchange_rate.created', row.id, [
          { field: 'pair', before: null, after: `${input.fromCurrency}/${input.toCurrency}` },
          { field: 'rate', before: null, after: input.rate },
          { field: 'effectiveOn', before: null, after: input.effectiveOn },
        ]);
        return exchangeRateView(row);
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new ApiError(409, 'conflict', 'A rate for this pair and day already exists.', [
          { field: 'effectiveOn', message: 'taken' },
        ]);
      }
      throw error;
    }
  }

  /** 52-28 — the resolved tax-document rules for this organization (`finance.view`). */
  async taxDocumentRules(
    context: TenantContext,
    principal: Principal,
  ): Promise<TaxDocumentRulesView> {
    this.require(principal, context, FINANCE_VIEW);
    return this.options.database.read(context, async (r) =>
      taxDocumentRulesFor(await this.loadProfile(r, context)),
    );
  }

  async readiness(context: TenantContext, principal: Principal): Promise<FinanceReadiness> {
    this.require(principal, context, FINANCE_VIEW);
    return this.options.database.read(context, async (r) => {
      const profile = await this.loadProfile(r, context);
      const rates = await this.options.repository.taxRates(r, context.organizationId);
      // A never-listed organization gets its seeds on the first list, so 0 rows is not "missing".
      const active =
        rates.length === 0 ? 1 : rates.filter((rate) => rate.archivedAt === null).length;
      return readiness(profile, profile.saved, active);
    });
  }

  private async defaults(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<FinanceProfileValues> {
    return defaultProfile(
      await this.options.repository.organization(runner, context.organizationId),
    );
  }

  private async loadProfile(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<FinanceProfileView> {
    const row = await this.options.repository.profile(runner, context.organizationId);
    if (row === null) {
      const defaults = await this.defaults(runner, context);
      return {
        ...defaults,
        taxDocumentRule: ruleRow(defaults),
        saved: false,
        version: 0,
        updatedAt: null,
      };
    }
    const values = profileValues(row);
    return {
      ...values,
      taxDocumentRule: ruleRow(values),
      saved: true,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private require(principal: Principal, context: TenantContext, capability: Capability): void {
    const decision = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'finance.denied');
    }
  }

  private async audited(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: AuditAction,
    objectId: string | null,
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
      metadata: {},
      changes,
    });
  }
}
