import { hasCapability } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { PlatformRequestContext } from '../platform-admin/platform-admin.access.js';
import type { PlatformAdminActor } from '../platform-admin/platform-admin.guard.js';
import { platformAuditFor } from '../platform-admin/platform-audit.service.js';
import { SIGNAL_RULES, parseRuleUpdate, signalRule } from './signal-rules.js';
import type { SignalRule } from './signal-rules.js';
import type {
  AlertRuleRecord,
  SecuritySignalsStore,
  SignalFilter,
  SignalRecord,
} from './security-signals.repository.js';

/**
 * 56-23 — security signals, API half (0263). The worker detects and mails; this reads and tunes.
 *
 * - `organizationEvents` — an organization's own signals (`audit.read` and org-wide scope, as
 *   56-11's integrity check: signals are about the whole organization). NULL-organization
 *   (platform) rows never reach it: the read names the caller's organization.
 * - `platformSignals` / `rules` / `updateRule` — platform admins (`platform.settings.edit`; the
 *   guard demands a fresh step-up on every one). A rule change and its
 *   `platform.alert_rule_updated` audit row commit together; a deferred rule cannot be enabled.
 *
 * No shape carries a source hash, an IP or the detail JSON — only `hasSource`.
 */

export const SECURITY_SIGNALS_SERVICE = Symbol.for('tmanage.SecuritySignalsService');
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface SignalView {
  readonly id: string;
  readonly organizationId: string | null;
  readonly ruleKey: string;
  readonly label: { readonly en: string; readonly ar: string };
  readonly severity: string;
  readonly subjectType: string;
  readonly subjectId: string | null;
  readonly hasSource: boolean;
  readonly count: number;
  readonly windowStart: string;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly notifyStatus: string;
}

export interface SignalPage {
  readonly events: readonly SignalView[];
  readonly nextCursor: string | null;
}

export interface AlertRuleView extends SignalRule {
  readonly enabled: boolean;
  readonly threshold: { readonly count: number; readonly windowMinutes: number };
  readonly cooldownMinutes: number;
  readonly lastFiredAt: string | null;
  readonly updatedAt: string | null;
}

export interface SignalQuery {
  readonly kind?: string | undefined;
  readonly from?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: string | undefined;
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The filter is not valid.', [{ field, message }]);
}

export function parseSignalQuery(query: SignalQuery): SignalFilter {
  const kind = query.kind === undefined || query.kind === '' ? undefined : query.kind;
  if (kind !== undefined && signalRule(kind) === undefined) throw invalid('kind', 'a rule key');
  let from: Date | undefined;
  if (query.from !== undefined && query.from !== '') {
    from = new Date(query.from);
    if (Number.isNaN(from.getTime())) throw invalid('from', 'an ISO 8601 date-time');
  }
  const cursor = query.cursor === undefined || query.cursor === '' ? undefined : query.cursor;
  if (cursor !== undefined && !ID_SHAPE.test(cursor)) throw invalid('cursor', 'a signal id');
  const limit = query.limit === undefined ? DEFAULT_PAGE : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw invalid('limit', `1–${String(MAX_PAGE)}`);
  }
  return {
    ...(kind === undefined ? {} : { ruleKey: kind }),
    ...(from === undefined ? {} : { from }),
    ...(cursor === undefined ? {} : { before: cursor }),
    limit,
  };
}

export function toSignalView(record: SignalRecord): SignalView {
  return {
    id: record.id,
    organizationId: record.organizationId,
    ruleKey: record.ruleKey,
    label: signalRule(record.ruleKey)?.label ?? { en: record.ruleKey, ar: record.ruleKey },
    severity: record.severity,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    hasSource: record.hasSource,
    count: record.count,
    windowStart: record.windowStart.toISOString(),
    firstSeen: record.firstSeen.toISOString(),
    lastSeen: record.lastSeen.toISOString(),
    notifyStatus: record.notifyStatus,
  };
}

function page(records: readonly SignalRecord[], limit: number): SignalPage {
  const events = records.slice(0, limit).map(toSignalView);
  const last = events[events.length - 1];
  return { events, nextCursor: records.length > limit && last !== undefined ? last.id : null };
}

function threshold(json: string): { count: number; windowMinutes: number } {
  try {
    const parsed = JSON.parse(json) as { count?: unknown; windowMinutes?: unknown };
    return { count: Number(parsed.count ?? 0), windowMinutes: Number(parsed.windowMinutes ?? 0) };
  } catch {
    return { count: 0, windowMinutes: 0 };
  }
}

function ruleView(entry: SignalRule, row: AlertRuleRecord | undefined): AlertRuleView {
  return {
    ...entry,
    enabled: entry.status === 'active' && (row?.enabled ?? false),
    threshold: threshold(row?.thresholdJson ?? '{}'),
    cooldownMinutes: row?.cooldownMinutes ?? 0,
    lastFiredAt: row?.lastFiredAt?.toISOString() ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export class SecuritySignalsService {
  constructor(
    private readonly store: SecuritySignalsStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async organizationEvents(
    context: TenantContext,
    principal: Principal,
    query: SignalQuery,
  ): Promise<SignalPage> {
    if (!hasCapability(principal.role, 'audit.read') || !principal.hasOrgWideScope) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    const filter = parseSignalQuery(query);
    const rows = await this.store.listForOrganization(context, {
      ...filter,
      limit: filter.limit + 1,
    });
    return page(rows, filter.limit);
  }

  async platformSignals(
    query: SignalQuery & { readonly scope?: string | undefined },
    context: PlatformRequestContext,
  ): Promise<SignalPage> {
    const filter = parseSignalQuery(query);
    if (query.scope !== undefined && query.scope !== 'all' && query.scope !== 'platform') {
      throw invalid('scope', 'all | platform');
    }
    const rows = await this.store.listAll(
      { ...filter, limit: filter.limit + 1, platformOnly: query.scope === 'platform' },
      context.correlationId,
    );
    return page(rows, filter.limit);
  }

  async rules(context: PlatformRequestContext): Promise<readonly AlertRuleView[]> {
    const rows = new Map(
      (await this.store.listRules(context.correlationId)).map((row) => [row.ruleKey, row]),
    );
    return SIGNAL_RULES.map((entry) => ruleView(entry, rows.get(entry.key)));
  }

  async updateRule(
    actor: PlatformAdminActor,
    ruleKey: string,
    body: Readonly<Record<string, unknown>>,
    context: PlatformRequestContext,
  ): Promise<AlertRuleView> {
    const entry = signalRule(ruleKey);
    if (entry === undefined) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const update = parseRuleUpdate(body);
    if (entry.status === 'deferred' && update.enabled) {
      throw new ApiError(
        409,
        'conflict',
        entry.deferredReason ?? 'This rule cannot run yet.',
        undefined,
        'alert_rule_deferred',
      );
    }
    const at = this.now();
    const saved = await this.store.updateRuleAudited(
      ruleKey,
      (row) => {
        const next = {
          enabled: update.enabled,
          thresholdJson: JSON.stringify({
            count: update.count,
            windowMinutes: update.windowMinutes,
          }),
          cooldownMinutes: update.cooldownMinutes ?? row.cooldownMinutes,
          updatedBy: actor.account.userId,
          updatedAt: at,
        };
        return {
          next,
          audit: platformAuditFor(actor, context, {
            action: 'platform.alert_rule_updated',
            targetType: 'setting',
            targetId: null,
            targetLabel: ruleKey,
            reason: null,
            beforeJson: JSON.stringify({
              enabled: row.enabled,
              threshold: threshold(row.thresholdJson),
              cooldownMinutes: row.cooldownMinutes,
            }),
            afterJson: JSON.stringify({
              enabled: next.enabled,
              threshold: threshold(next.thresholdJson),
              cooldownMinutes: next.cooldownMinutes,
            }),
          }),
        };
      },
      context.correlationId,
    );
    if (saved === null) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return ruleView(entry, saved);
  }
}
