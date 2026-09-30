import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { isUuid } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { INBOX_RULE_CATEGORIES, INBOX_RULE_MATCH_TYPES } from '../../common/database/schema.js';
import type { InboxRuleCategory, InboxRuleMatchType } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { NewInboxRule } from './rules.repository.js';
import type { InboxRuleView, InboxRulesService, ResolvedCategory } from './rules.service.js';

/** Token the module wires the service under; module-local so it collides with nothing exported. */
export const INBOX_RULES_SERVICE = Symbol.for('tmanage.InboxRulesService');

/** The longest a `match_value` may be, mirroring the column width. */
const MAX_MATCH_VALUE = 190;
/** The largest `position` a client may assign, keeping a member's list bounded and int-safe. */
const MAX_POSITION = 10_000;

const MATCH_TYPES: ReadonlySet<string> = new Set(INBOX_RULE_MATCH_TYPES);
const CATEGORIES: ReadonlySet<string> = new Set(INBOX_RULE_CATEGORIES);

/**
 * INBOX-001 per-user inbox routing rules (x301, module Inbox). Add a rule, list the caller's rules,
 * resolve the caller's notifications against them read-side, and remove one.
 *
 * ## Own rules only, and the capability reused rather than invented
 *
 * There is no membership in the path or body: the subject is the authenticated `principal`'s
 * membership, so no caller can read, add, apply or remove another member's rule — the request has no
 * way to name one. The capability is **`work.read`**, the same choice the inbox itself, and the
 * per-member preferences (`widget-prefs`, `a11y`, `notification_kind_prefs`), already made: it is the
 * one capability every internal role holds and no client role does, `12-PERMISSION-MATRIX` names no
 * inbox-rules capability, and pass-25 forbids editing `capabilities.ts`. The control that matters is
 * here and in the service — a member reads and writes their own rows and nothing else.
 *
 * ## `match_type` and `category` are closed allowlists
 *
 * A `match_type` outside {@link INBOX_RULE_MATCH_TYPES} or a `category` outside
 * {@link INBOX_RULE_CATEGORIES} is a single 400 and nothing is written — validation is here rather
 * than in the store because a malformed body is the client's error to be told about, not a state the
 * store should ever hold, the same division the sibling per-member controllers use.
 *
 * ## DELETE resolves before it authorizes
 *
 * `DELETE /inbox/rules/:id` is idempotent for the caller's own rules (a missing rule is still 204) but
 * refuses another member's rule with a 404 — the service resolves the rule by `(tenant, id)` first,
 * so a rule that belongs to someone else is never deleted and never distinguished from one that never
 * existed by anything the caller can observe beyond the 404 itself.
 */
@Controller('v1/organizations/:orgSlug/inbox/rules')
export class InboxRulesController {
  constructor(@Inject(INBOX_RULES_SERVICE) private readonly rules: InboxRulesService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly rules: readonly InboxRuleView[] }> {
    return { rules: await this.rules.list(context, principal) };
  }

  /**
   * Resolve the caller's most recent notifications against their rules, read-side. A distinct literal
   * segment so it can never be matched as `:id`.
   */
  @Get('resolve')
  @RequireCapability('work.read')
  async resolve(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly resolved: readonly ResolvedCategory[] }> {
    return { resolved: await this.rules.resolve(context, principal) };
  }

  @Post()
  @RequireCapability('work.read')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<InboxRuleView> {
    const rule = parseInput(body);
    return this.rules.create(context, principal, rule);
  }

  @Delete(':id')
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    if (!isUuid(id)) {
      throw new ApiError(400, 'validation_failed', 'The rule id is invalid', [
        { field: 'id', message: 'must be a rule id this API returned' },
      ]);
    }
    const { outcome } = await this.rules.remove(context, principal, id);
    if (outcome === 'forbidden') {
      throw new ApiError(404, 'not_found', 'No such rule');
    }
    // 'deleted' and 'absent' are both 204: the delete is idempotent for the caller's own rules.
  }
}

/**
 * Validate a POST body into a stored rule: `matchType` and `category` must each be a member of their
 * fixed allowlist, `matchValue` a non-empty string within the column width, and `position` a
 * non-negative integer within bounds. Any failure is a single 400 and nothing is written.
 */
function parseInput(body: unknown): NewInboxRule {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const matchType = value['matchType'];
  if (typeof matchType !== 'string' || !MATCH_TYPES.has(matchType)) {
    details.push({
      field: 'matchType',
      message: `must be one of ${INBOX_RULE_MATCH_TYPES.join(', ')}`,
    });
  }

  const category = value['category'];
  if (typeof category !== 'string' || !CATEGORIES.has(category)) {
    details.push({
      field: 'category',
      message: `must be one of ${INBOX_RULE_CATEGORIES.join(', ')}`,
    });
  }

  const matchValue = value['matchValue'];
  if (typeof matchValue !== 'string' || matchValue.length === 0) {
    details.push({ field: 'matchValue', message: 'must be a non-empty string' });
  } else if (matchValue.length > MAX_MATCH_VALUE) {
    details.push({ field: 'matchValue', message: `must be at most ${MAX_MATCH_VALUE} characters` });
  }

  const rawPosition = value['position'];
  const position = rawPosition === undefined ? 0 : rawPosition;
  if (
    typeof position !== 'number' ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position > MAX_POSITION
  ) {
    details.push({
      field: 'position',
      message: `must be an integer between 0 and ${MAX_POSITION}`,
    });
  }

  if (details.length > 0) {
    throw new ApiError(400, 'validation_failed', 'The inbox rule is invalid', details);
  }

  return {
    matchType: matchType as InboxRuleMatchType,
    matchValue: matchValue as string,
    category: category as InboxRuleCategory,
    position: position as number,
  };
}
