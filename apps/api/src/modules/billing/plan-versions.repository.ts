import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { PlatformAuditInput } from '../platform-admin/platform-admin.repository.js';
import { insertPlatformAudit } from '../platform-admin/platform-audit.service.js';
import { readPlanId } from './plan-catalog.js';
import { parsePlanFeatures, parsePlanLimits, readPlanCurrency } from './plan-versions.js';
import type { NewPlanVersion, PlanCurrency, PlanVersion } from './plan-versions.js';

/**
 * 57-02 · every statement on the global `plan_versions` ladder (0351). Reached only through the
 * identity path: no organization owns a plan. Fixed SQL with bound values — no request text is
 * ever part of a statement. INSERT only: a published version is never rewritten.
 */

/** More than every plan × currency × version the ladder will hold for years. */
export const MAX_PLAN_VERSION_ROWS = 500;

const COLUMNS = `v.id as id, v.plan_id as plan_id, v.version as version, v.currency as currency,
  v.monthly_cents as monthly_cents, v.yearly_cents as yearly_cents, v.limits_json as limits_json,
  v.features_json as features_json, v.effective_from as effective_from`;

export const PLAN_VERSIONS_SQL = {
  all: `select ${COLUMNS} from plan_versions v
    order by v.plan_id, v.currency, v.version desc limit ${MAX_PLAN_VERSION_ROWS}`,
  forPlan: `select ${COLUMNS} from plan_versions v where v.plan_id = ? and v.currency = ?
    order by v.version desc limit ${MAX_PLAN_VERSION_ROWS}`,
  lastVersion: `select coalesce(max(v.version), 0) as last_version from plan_versions v
    where v.plan_id = ? and v.currency = ? for update`,
  insert: `insert into plan_versions (id, plan_id, version, currency, monthly_cents, yearly_cents,
      limits_json, features_json, effective_from, created_by_user_id, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, current_timestamp(3))`,
} as const;

const TABLES = ['plan_versions'] as const;
const WRITE_TABLES = ['plan_versions', 'platform_admin_audit_events'] as const;

type Row = RowDataPacket & Record<string, unknown>;

/** The statements the plan-versions service needs. Faked by the unit test. */
export interface PlanVersionsStore {
  all(correlationId: string): Promise<readonly PlanVersion[]>;
  forPlan(
    planId: string,
    currency: PlanCurrency,
    correlationId: string,
  ): Promise<readonly PlanVersion[]>;
  /** Publish `input` as the plan's next version, with its platform audit row, in one transaction. */
  create(
    input: NewPlanVersion,
    createdBy: string,
    correlationId: string,
    audit: (created: PlanVersion) => PlatformAuditInput,
  ): Promise<PlanVersion>;
}

/** MySQL hands JSON back parsed; MariaDB (a LONGTEXT alias) hands back the text. */
function json(value: unknown): unknown {
  return typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
}

function centsOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toVersion(row: Row): PlanVersion {
  return {
    id: String(row['id']),
    planId: readPlanId(row['plan_id']),
    version: Number(row['version']),
    currency: readPlanCurrency(row['currency']),
    monthlyCents: centsOrNull(row['monthly_cents']),
    yearlyCents: centsOrNull(row['yearly_cents']),
    limits: parsePlanLimits(json(row['limits_json'])),
    features: parsePlanFeatures(json(row['features_json'])),
    effectiveFrom: new Date(row['effective_from'] as Date | string),
  };
}

export class PlanVersionsRepository implements PlanVersionsStore {
  constructor(private readonly database: TenantDatabase) {}

  async all(correlationId: string): Promise<readonly PlanVersion[]> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) =>
      (await db.query<Row[]>(PLAN_VERSIONS_SQL.all)).map(toVersion),
    );
  }

  async forPlan(
    planId: string,
    currency: PlanCurrency,
    correlationId: string,
  ): Promise<readonly PlanVersion[]> {
    return this.database.identityRead({ correlationId, tables: [...TABLES] }, async (db) =>
      (await db.query<Row[]>(PLAN_VERSIONS_SQL.forPlan, [planId, currency])).map(toVersion),
    );
  }

  async create(
    input: NewPlanVersion,
    createdBy: string,
    correlationId: string,
    audit: (created: PlanVersion) => PlatformAuditInput,
  ): Promise<PlanVersion> {
    return this.database.identityTransaction(
      { correlationId, tables: [...WRITE_TABLES] },
      async (tx) => {
        const last = await tx.query<Row[]>(PLAN_VERSIONS_SQL.lastVersion, [
          input.planId,
          input.currency,
        ]);
        const created: PlanVersion = {
          ...input,
          id: uuidv7(),
          version: Number(last[0]?.['last_version'] ?? 0) + 1,
        };
        await tx.query(PLAN_VERSIONS_SQL.insert, [
          created.id,
          created.planId,
          created.version,
          created.currency,
          created.monthlyCents,
          created.yearlyCents,
          JSON.stringify(created.limits),
          JSON.stringify(created.features),
          created.effectiveFrom,
          createdBy,
        ]);
        await insertPlatformAudit(tx, audit(created));
        return created;
      },
    );
  }
}
