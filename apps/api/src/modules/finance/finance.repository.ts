import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  orgDocumentSequences,
  orgExchangeRates,
  orgFinanceProfiles,
  orgTaxRates,
  organizations,
} from '../../common/database/schema.js';
import type {
  OrgExchangeRateRow,
  OrgFinanceProfileRow,
  OrgTaxRateRow,
} from '../../common/database/schema.js';
import type { TenantQueryRunner } from '../../common/database/tenant-context.js';
import type {
  DocumentKind,
  DocumentSequenceStore,
  NumberingSettings,
} from './document-sequences.js';
import type { ExchangeRateInput, FinanceProfileValues, TaxRateInput } from './finance-rules.js';

/**
 * 52-23 — the four finance tables (0260) plus the organization's name, locale and time zone.
 * Every statement carries the `organization_id` predicate from the caller's context; another
 * organization's row is simply absent. Also the DB half of the document-sequence port.
 */
export class FinanceRepository implements DocumentSequenceStore {
  async organization(
    runner: TenantQueryRunner,
    organizationId: string,
  ): Promise<{
    readonly name: string;
    readonly defaultLocale: string;
    readonly timezone: string;
  } | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        name: organizations.name,
        defaultLocale: organizations.defaultLocale,
        timezone: organizations.timezone,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async profile(
    runner: TenantQueryRunner,
    organizationId: string,
    lock = false,
  ): Promise<OrgFinanceProfileRow | null> {
    const query = tenantDrizzle(runner)
      .select()
      .from(orgFinanceProfiles)
      .where(eq(orgFinanceProfiles.organizationId, organizationId))
      .limit(1);
    const rows = lock ? await query.for('update') : await query;
    return rows[0] ?? null;
  }

  async insertProfile(
    runner: TenantQueryRunner,
    organizationId: string,
    values: FinanceProfileValues,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(orgFinanceProfiles)
      .values({
        id: uuidv7(),
        organizationId,
        ...values,
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
  }

  async updateProfile(
    runner: TenantQueryRunner,
    organizationId: string,
    values: FinanceProfileValues,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(orgFinanceProfiles)
      .set({ ...values, updatedAt: at, version: sql`${orgFinanceProfiles.version} + 1` })
      .where(eq(orgFinanceProfiles.organizationId, organizationId));
  }

  /**
   * 52-01. The manual timer's rounding step alone — the owner's choice in the time settings. Bumps
   * `version` like a profile save, so a finance form opened before it reloads instead of
   * overwriting it.
   */
  async updateRoundingMinutes(
    runner: TenantQueryRunner,
    organizationId: string,
    roundingMinutes: number,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(orgFinanceProfiles)
      .set({ roundingMinutes, updatedAt: at, version: sql`${orgFinanceProfiles.version} + 1` })
      .where(eq(orgFinanceProfiles.organizationId, organizationId));
  }

  async taxRates(
    runner: TenantQueryRunner,
    organizationId: string,
  ): Promise<readonly OrgTaxRateRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(orgTaxRates)
      .where(eq(orgTaxRates.organizationId, organizationId))
      .orderBy(desc(orgTaxRates.isDefault), asc(orgTaxRates.code));
  }

  async taxRate(
    runner: TenantQueryRunner,
    organizationId: string,
    taxRateId: string,
  ): Promise<OrgTaxRateRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgTaxRates)
      .where(and(eq(orgTaxRates.organizationId, organizationId), eq(orgTaxRates.id, taxRateId)))
      .limit(1)
      .for('update');
    return rows[0] ?? null;
  }

  /** Insert; `ignoreDuplicate` makes the first-read seed safe against a concurrent seed. */
  async insertTaxRate(
    runner: TenantQueryRunner,
    organizationId: string,
    input: TaxRateInput,
    at: Date,
    ignoreDuplicate = false,
  ): Promise<string> {
    const id = uuidv7();
    const insert = tenantDrizzle(runner)
      .insert(orgTaxRates)
      .values({ id, organizationId, ...input, archivedAt: null, createdAt: at, updatedAt: at });
    await (ignoreDuplicate
      ? insert.onDuplicateKeyUpdate({ set: { code: sql`${orgTaxRates.code}` } })
      : insert);
    return id;
  }

  async updateTaxRate(
    runner: TenantQueryRunner,
    organizationId: string,
    taxRateId: string,
    change: Partial<
      Pick<
        OrgTaxRateRow,
        'nameEn' | 'nameAr' | 'rateBp' | 'zatcaCategory' | 'isDefault' | 'archivedAt'
      >
    >,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(orgTaxRates)
      .set({ ...change, updatedAt: at })
      .where(and(eq(orgTaxRates.organizationId, organizationId), eq(orgTaxRates.id, taxRateId)));
  }

  /** Only one default rate: clear the flag on every other rate of the organization. */
  async clearDefaultTaxRate(
    runner: TenantQueryRunner,
    organizationId: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(orgTaxRates)
      .set({ isDefault: false, updatedAt: at })
      .where(and(eq(orgTaxRates.organizationId, organizationId), eq(orgTaxRates.isDefault, true)));
  }

  async exchangeRates(
    runner: TenantQueryRunner,
    organizationId: string,
    filter: {
      readonly fromCurrency?: string;
      readonly toCurrency?: string;
      readonly limit: number;
    },
  ): Promise<readonly OrgExchangeRateRow[]> {
    const predicates = [eq(orgExchangeRates.organizationId, organizationId)];
    if (filter.fromCurrency !== undefined) {
      predicates.push(eq(orgExchangeRates.fromCurrency, filter.fromCurrency));
    }
    if (filter.toCurrency !== undefined)
      predicates.push(eq(orgExchangeRates.toCurrency, filter.toCurrency));
    return tenantDrizzle(runner)
      .select()
      .from(orgExchangeRates)
      .where(and(...predicates))
      .orderBy(desc(orgExchangeRates.effectiveOn), asc(orgExchangeRates.fromCurrency))
      .limit(filter.limit);
  }

  async insertExchangeRate(
    runner: TenantQueryRunner,
    organizationId: string,
    input: ExchangeRateInput,
    createdBy: string,
    at: Date,
  ): Promise<OrgExchangeRateRow> {
    const row: OrgExchangeRateRow = {
      id: uuidv7(),
      organizationId,
      fromCurrency: input.fromCurrency,
      toCurrency: input.toCurrency,
      rate: input.rate,
      effectiveOn: input.effectiveOn,
      source: 'manual',
      createdBy,
      createdAt: at,
    };
    await tenantDrizzle(runner).insert(orgExchangeRates).values(row);
    return row;
  }

  // ---- DocumentSequenceStore ----

  async settings(
    runner: TenantQueryRunner,
    organizationId: string,
    kind: DocumentKind,
  ): Promise<NumberingSettings> {
    const profile = await this.profile(runner, organizationId);
    const organization = await this.organization(runner, organizationId);
    const prefix =
      kind === 'invoice'
        ? (profile?.invoicePrefix ?? 'INV')
        : kind === 'quote'
          ? (profile?.quotePrefix ?? 'QT')
          : (profile?.creditNotePrefix ?? 'CN');
    return {
      prefix,
      reset: profile?.numberingReset === 'never' ? 'never' : 'yearly',
      timeZone: organization?.timezone ?? 'UTC',
    };
  }

  /** Create the counter row if absent; a concurrent creator's row wins and nothing changes. */
  async ensure(
    runner: TenantQueryRunner,
    organizationId: string,
    kind: DocumentKind,
    periodKey: string,
    at: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(orgDocumentSequences)
      .values({
        id: uuidv7(),
        organizationId,
        kind,
        periodKey,
        nextValue: 1,
        createdAt: at,
        updatedAt: at,
      })
      .onDuplicateKeyUpdate({ set: { nextValue: sql`${orgDocumentSequences.nextValue}` } });
  }

  /** Lock the counter row FOR UPDATE, take its value, advance it — inside the caller's tx. */
  async lockAndTake(
    runner: TenantQueryRunner,
    organizationId: string,
    kind: DocumentKind,
    periodKey: string,
    at: Date,
  ): Promise<number> {
    const db = tenantDrizzle(runner);
    const key = and(
      eq(orgDocumentSequences.organizationId, organizationId),
      eq(orgDocumentSequences.kind, kind),
      eq(orgDocumentSequences.periodKey, periodKey),
    );
    const rows = await db
      .select({ nextValue: orgDocumentSequences.nextValue })
      .from(orgDocumentSequences)
      .where(key)
      .limit(1)
      .for('update');
    const value = rows[0]?.nextValue;
    if (value === undefined) throw new Error('document sequence row missing after ensure');
    await db
      .update(orgDocumentSequences)
      .set({ nextValue: value + 1, updatedAt: at })
      .where(key);
    return value;
  }
}
