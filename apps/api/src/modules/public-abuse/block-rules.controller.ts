import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { OrgBlockRuleRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  BLOCK_RULE_KINDS,
  BlockRulesRepository,
  canonicalBlockValue,
} from './block-rules.repository.js';
import type { BlockRuleInput, BlockRuleKind } from './block-rules.repository.js';

/**
 * 52-21 — an organization's block rules for its public doors:
 * `GET/POST/DELETE /v1/organizations/:orgSlug/admin/block-rules`, every route behind
 * `org.security.manage` (the security-admin gate; no capability invented). NEVER for the AI
 * connector, like the other `org.security.manage` routes.
 *
 * The route guard asks the coarse question; {@link BlockRulesService} authorizes again as the
 * authoritative decision. A DELETE resolves the rule tenant-scoped BEFORE authorizing, so another
 * organization's rule id is the same 404 an absent one gives and nothing is removed.
 *
 * TODO(56-04): add `org_block_rules` rows to the cross-tenant corpus once that suite takes new
 * tables; the cross-tenant refusal is proved here against the store fake meanwhile.
 */

export interface BlockRuleView {
  readonly id: string;
  readonly kind: BlockRuleKind;
  readonly value: string;
  readonly reason: string | null;
  readonly createdAt: string;
}

export type BlockRuleList = {
  readonly rules: readonly BlockRuleView[];
};

export function toBlockRuleView(row: OrgBlockRuleRow): BlockRuleView {
  return {
    id: row.id,
    kind: row.kind as BlockRuleKind,
    value: row.value,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface BlockRuleStore {
  listAll(runner: TenantQueryRunner, context: TenantContext): Promise<readonly OrgBlockRuleRow[]>;
  findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    ruleId: string,
  ): Promise<OrgBlockRuleRow | null>;
  findByValue(
    runner: TenantQueryRunner,
    context: TenantContext,
    kind: BlockRuleKind,
    value: string,
  ): Promise<OrgBlockRuleRow | null>;
  insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: BlockRuleInput,
  ): Promise<OrgBlockRuleRow>;
  remove(runner: TenantQueryRunner, context: TenantContext, ruleId: string): Promise<void>;
}

const MAX_REASON = 200;

export class BlockRulesService {
  constructor(
    private readonly databaseOrNull: TenantDatabase | null,
    private readonly store: BlockRuleStore = new BlockRulesRepository(),
  ) {}

  /** A composition without a database (a unit boot) has no block list to manage. */
  private get database(): TenantDatabase {
    if (this.databaseOrNull === null) throw new Error('block rules need the tenant database');
    return this.databaseOrNull;
  }

  async list(context: TenantContext, principal: Principal): Promise<readonly BlockRuleView[]> {
    this.requireSecurityManage(principal, context, 'block_rules.list');
    const rows = await this.database.read(context, (runner) => this.store.listAll(runner, context));
    return rows.map(toBlockRuleView);
  }

  async add(context: TenantContext, principal: Principal, body: unknown): Promise<BlockRuleView> {
    this.requireSecurityManage(principal, context, 'block_rules.add');
    const input = validateBlockRule(body);
    const row = await this.database.transaction(context, async (tx) => {
      if (await this.store.findByValue(tx, context, input.kind, input.value)) {
        throw new ApiError(
          409,
          'conflict',
          'That rule is already on the block list.',
          undefined,
          'block_rules.duplicate',
        );
      }
      return this.store.insert(tx, context, input);
    });
    return toBlockRuleView(row);
  }

  async remove(context: TenantContext, principal: Principal, ruleId: string): Promise<void> {
    if (typeof ruleId !== 'string' || ruleId === '') {
      throw new ApiError(400, 'validation_failed', 'ruleId is required', [
        { field: 'ruleId', message: 'must be a non-empty string' },
      ]);
    }
    await this.database.transaction(context, async (tx) => {
      const rule = await this.store.findById(tx, context, ruleId);
      if (!rule) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'block_rules.not_visible',
        );
      }
      this.requireSecurityManage(principal, context, 'block_rules.remove');
      await this.store.remove(tx, context, ruleId);
    });
  }

  private requireSecurityManage(
    principal: Principal,
    context: TenantContext,
    action: string,
  ): void {
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
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        `${action}:${verdict.code}`,
      );
    }
  }
}

export function validateBlockRule(raw: unknown): BlockRuleInput {
  const body = (raw ?? {}) as { kind?: unknown; value?: unknown; reason?: unknown };
  const details: { field: string; message: string }[] = [];
  const kind = BLOCK_RULE_KINDS.find((candidate) => candidate === body.kind);
  if (kind === undefined) details.push({ field: 'kind', message: 'must be email, domain or ip' });
  const value =
    kind !== undefined && typeof body.value === 'string'
      ? canonicalBlockValue(kind, body.value)
      : null;
  if (kind !== undefined && value === null) {
    details.push({ field: 'value', message: `must be a valid ${kind}` });
  }
  let reason: string | null = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== 'string' || body.reason.trim().length > MAX_REASON) {
      details.push({ field: 'reason', message: `must be a string of at most ${MAX_REASON}` });
    } else if (body.reason.trim() !== '') {
      reason = body.reason.trim();
    }
  }
  if (details.length > 0 || kind === undefined || value === null) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
  }
  return { kind, value, reason };
}

export const BLOCK_RULES_SERVICE = Symbol.for('tmanage.BlockRulesService');

@Controller('v1/organizations/:orgSlug/admin/block-rules')
export class BlockRulesController {
  constructor(@Inject(BLOCK_RULES_SERVICE) private readonly rules: BlockRulesService) {}

  @Get()
  @RequireCapability('org.security.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BlockRuleList> {
    return { rules: await this.rules.list(context, principal) };
  }

  @Post()
  @RequireCapability('org.security.manage')
  @HttpCode(201)
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<BlockRuleView> {
    return this.rules.add(context, principal, body);
  }

  @Delete(':ruleId')
  @RequireCapability('org.security.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('ruleId') ruleId: string,
  ): Promise<void> {
    await this.rules.remove(context, principal, ruleId);
  }
}
