import { isIP } from 'node:net';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { orgBlockRules } from '../../common/database/schema.js';
import type { OrgBlockRuleRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 52-21 — `org_block_rules` (0255, TENANT): one organization's "never accept from" list for its
 * public doors. The one file holding a driver handle for the table.
 *
 * Every member-side read and write is bound to `organization_id` from the context (never from a
 * body), and the composite `(organization_id, id)` key makes a cross-tenant id a non-existent row.
 * The public guard's lookup ({@link matchingBlockRule}) has no session and so no context: it runs
 * on `bootstrapRead` with `org_block_rules` as its only table and the organization the public form
 * belongs to as an explicit predicate.
 */

export const BLOCK_RULE_KINDS = ['email', 'domain', 'ip'] as const;
export type BlockRuleKind = (typeof BLOCK_RULE_KINDS)[number];
export const MAX_BLOCK_RULES = 500;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DOMAIN_SHAPE = /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

/** The canonical stored value of a rule, or `null` when it is not that kind's shape. */
export function canonicalBlockValue(kind: BlockRuleKind, raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value === '' || value.length > 254) return null;
  if (kind === 'email') return EMAIL_SHAPE.test(value) ? value : null;
  if (kind === 'domain') {
    const domain = value.replace(/^@/u, '');
    return DOMAIN_SHAPE.test(domain) ? domain : null;
  }
  return isIP(value) === 0 ? null : value;
}

export interface BlockRuleInput {
  readonly kind: BlockRuleKind;
  readonly value: string;
  readonly reason: string | null;
}

export class BlockRulesRepository {
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OrgBlockRuleRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(orgBlockRules)
      .where(eq(orgBlockRules.organizationId, context.organizationId))
      .orderBy(asc(orgBlockRules.createdAt), asc(orgBlockRules.id))
      .limit(MAX_BLOCK_RULES);
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    ruleId: string,
  ): Promise<OrgBlockRuleRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgBlockRules)
      .where(
        and(eq(orgBlockRules.organizationId, context.organizationId), eq(orgBlockRules.id, ruleId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findByValue(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: BlockRuleKind,
    value: string,
  ): Promise<OrgBlockRuleRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(orgBlockRules)
      .where(
        and(
          eq(orgBlockRules.organizationId, context.organizationId),
          eq(orgBlockRules.kind, kind),
          eq(orgBlockRules.value, value),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: BlockRuleInput,
  ): Promise<OrgBlockRuleRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(orgBlockRules)
      .values({
        id,
        organizationId: context.organizationId,
        kind: input.kind,
        value: input.value,
        reason: input.reason,
        createdByUserId: context.userId,
        createdAt: sql`current_timestamp(3)`,
      });
    const created = await this.findById(runner, context, id);
    if (!created) throw new Error('block rule vanished immediately after insert');
    return created;
  }

  async remove(runner: TenantQueryRunner, context: TenantContext, ruleId: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(orgBlockRules)
      .where(
        and(eq(orgBlockRules.organizationId, context.organizationId), eq(orgBlockRules.id, ruleId)),
      );
  }
}

export interface BlockSubject {
  readonly email?: string | undefined;
  readonly domain?: string | undefined;
  readonly ip?: string | undefined;
}

/** The first rule of `organizationId` matching the subject, or `null`. */
export type BlockRuleLookup = (
  organizationId: string,
  subject: BlockSubject,
  correlationId: string,
) => Promise<{ readonly kind: BlockRuleKind } | null>;

export function matchingBlockRule(database: TenantDatabase): BlockRuleLookup {
  return async (organizationId, subject, correlationId) => {
    const pairs: [BlockRuleKind, string][] = [];
    if (subject.email) pairs.push(['email', subject.email.trim().toLowerCase()]);
    if (subject.domain) pairs.push(['domain', subject.domain.trim().toLowerCase()]);
    if (subject.ip) pairs.push(['ip', subject.ip.trim().toLowerCase()]);
    if (pairs.length === 0) return null;
    const rows = await database.bootstrapRead(
      {
        correlationId,
        reason:
          'a public form has no session: reading the block list of the one organization the ' +
          'form belongs to, named by its public address',
        tables: ['org_block_rules'],
      },
      (runner) =>
        runner.query<RowDataPacket[]>(
          `select kind from org_block_rules
            where organization_id = ? and (${pairs.map(() => '(kind = ? and value = ?)').join(' or ')})
            limit 1`,
          [organizationId, ...pairs.flat()],
        ),
    );
    const kind = rows[0]?.['kind'];
    return typeof kind === 'string' ? { kind: kind as BlockRuleKind } : null;
  };
}
