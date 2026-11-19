import { createHash } from 'node:crypto';
import {
  FLAG_ROLLOUTS,
  parseFlagLockList,
  percentageBucketInput,
  percentageBucketOfDigest,
  resolveFlagChain,
} from '@tmanage/domain';
import type { FlagRollout, PlatformFlagLayer } from '@tmanage/domain';
import type { WorkerTransaction } from './worker-database.js';

/**
 * B05 — one per-organization feature flag as the worker sees it: the same read chain the API's
 * `feature-gate.ts` resolves (domain `flags/flag-chain.ts`: server lock → platform override →
 * the organization's row → platform rollout → the code default), so a sweep gated by a flag runs
 * for exactly the organizations whose screens show the feature.
 *
 * The flag key and its code default are the caller's (the worker cannot import the API's
 * `OPTIONAL_MODULE_FLAGS`; `signals-sweeper.ts` names `business_briefing`, default off).
 * Grants: SELECT on `organizations`, `org_feature_flags`, `platform_feature_flags`,
 * `platform_org_flag_overrides`.
 */

export interface WorkerFlag {
  readonly key: string;
  readonly codeDefault: boolean;
}

const SQL = {
  liveOrganizations: `SELECT o.id FROM organizations o
   WHERE o.deleted_at IS NULL AND o.suspended_at IS NULL
   ORDER BY o.id
   LIMIT ?`,
  orgRows: `SELECT ff.organization_id, ff.enabled FROM org_feature_flags ff WHERE ff.flag_key = ?`,
  orgRow: `SELECT ff.enabled FROM org_feature_flags ff
   WHERE ff.organization_id = ? AND ff.flag_key = ?`,
  layer: `SELECT f.enabled, f.rollout, f.percentage, f.allowlist_org_ids_json AS allowlist
    FROM platform_feature_flags f WHERE f.flag_key = ?`,
  overrides: `SELECT o.organization_id, o.enabled FROM platform_org_flag_overrides o
   WHERE o.flag_key = ? AND o.removed_at IS NULL`,
  override: `SELECT o.enabled FROM platform_org_flag_overrides o
   WHERE o.organization_id = ? AND o.flag_key = ? AND o.removed_at IS NULL`,
} as const;

interface LayerRow {
  readonly enabled: unknown;
  readonly rollout: unknown;
  readonly percentage: unknown;
  readonly allowlist: unknown;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function idList(raw: unknown): readonly string[] {
  const parsed: unknown = typeof raw === 'string' ? safeJson(raw) : raw;
  return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function toLayer(row: LayerRow | undefined): PlatformFlagLayer | undefined {
  if (row === undefined) return undefined;
  const rollout = (FLAG_ROLLOUTS as readonly unknown[]).includes(row.rollout)
    ? (row.rollout as FlagRollout)
    : 'everyone';
  const percentage = row.percentage === null ? null : Number(row.percentage);
  return {
    enabled: bool(row.enabled),
    rollout,
    percentage: Number.isFinite(percentage) ? percentage : null,
    allowlist: idList(row.allowlist),
  };
}

function lockFor(flag: WorkerFlag, env: NodeJS.ProcessEnv): boolean | undefined {
  const isKey = (value: unknown): value is string => value === flag.key;
  return parseFlagLockList(env['TMANAGE_FLAG_LOCKS'], isKey)[flag.key];
}

function bucketOf(flag: WorkerFlag, organizationId: string): number {
  const input = percentageBucketInput(flag.key, organizationId);
  return percentageBucketOfDigest(createHash('sha256').update(input).digest());
}

function resolve(
  flag: WorkerFlag,
  organizationId: string,
  parts: {
    readonly lock: boolean | undefined;
    readonly override: boolean | undefined;
    readonly orgRow: boolean | undefined;
    readonly layer: PlatformFlagLayer | undefined;
  },
): boolean {
  return resolveFlagChain({
    organizationId,
    ...parts,
    bucket: () => bucketOf(flag, organizationId),
    codeDefault: flag.codeDefault,
  });
}

/** The live organizations (at most `limit`, by id) for which the flag resolves on. */
export async function organizationsWithFlagOn(
  tx: WorkerTransaction,
  flag: WorkerFlag,
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly string[]> {
  const lock = lockFor(flag, env);
  if (lock === false) return [];
  const organizations = await tx.query<readonly { readonly id: string }[]>(SQL.liveOrganizations, [
    Math.max(1, Math.trunc(limit)),
  ]);
  const rowsOf = async (sql: string) =>
    new Map(
      (
        await tx.query<readonly { readonly organization_id: string; readonly enabled: unknown }[]>(
          sql,
          [flag.key],
        )
      ).map((row) => [row.organization_id, bool(row.enabled)] as const),
    );
  const orgRows = await rowsOf(SQL.orgRows);
  const overrides = await rowsOf(SQL.overrides);
  const layer = toLayer((await tx.query<readonly LayerRow[]>(SQL.layer, [flag.key]))[0]);
  return organizations
    .map((row) => row.id)
    .filter((id) =>
      resolve(flag, id, { lock, override: overrides.get(id), orgRow: orgRows.get(id), layer }),
    );
}

/** Whether the flag resolves on for one organization (re-checked at notice delivery). */
export async function isFlagOn(
  tx: WorkerTransaction,
  flag: WorkerFlag,
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const one = async (sql: string): Promise<boolean | undefined> => {
    const rows = await tx.query<readonly { readonly enabled: unknown }[]>(sql, [
      organizationId,
      flag.key,
    ]);
    return rows[0] === undefined ? undefined : bool(rows[0].enabled);
  };
  return resolve(flag, organizationId, {
    lock: lockFor(flag, env),
    override: await one(SQL.override),
    orgRow: await one(SQL.orgRow),
    layer: toLayer((await tx.query<readonly LayerRow[]>(SQL.layer, [flag.key]))[0]),
  });
}
