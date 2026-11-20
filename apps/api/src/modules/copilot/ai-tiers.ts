import type { AiModelId } from './ai-price-table.js';

/**
 * The tiers, pools and spending limits of the in-app AI (plan 62 §4.2 and §5, slice 62-06, B13).
 *
 * Pure policy: no I/O, no clock. The budget service (`ai-budget.service.ts`) applies it; the
 * repository (`ai-budget.repository.ts`) only ever compares against the numbers it is handed.
 * Every figure here is provisional until the Phase 0 benchmark (plan 62 §6) fixes it, and a change
 * is an edit of this one file.
 */

// ── Tiers ─────────────────────────────────────────────────────────────────────

/** The tiers, cheapest first. The vocabulary of `ai_tasks.tier` (0382). */
export const AI_TIERS = ['help', 'low', 'medium', 'medium_high', 'high'] as const;
export type AiTier = (typeof AI_TIERS)[number];

/** Who pays for a task's credits. The pool always records the real money either way. */
export type AiPayer = 'platform' | 'workspace';

export interface AiTierSpec {
  readonly tier: AiTier;
  /** The one model of the tier. Fixed when the task starts: no silent upgrade. */
  readonly model: AiModelId;
  /** The hold taken when the task starts and the most it can ever be charged, in credits. */
  readonly ceilingCredits: number;
  /** Whether the member sees an estimate and confirms before the task runs (plan 62 J4). */
  readonly asksFirst: boolean;
  readonly payer: AiPayer;
}

const HAIKU: AiModelId = 'claude-haiku-5-5';
const SONNET: AiModelId = 'claude-sonnet-5-5';

/** Plan 62 §4.2. Opus is never on our budget, so no tier names it. */
export const AI_TIER_SPECS: Readonly<Record<AiTier, AiTierSpec>> = Object.freeze({
  help: { tier: 'help', model: HAIKU, ceilingCredits: 3, asksFirst: false, payer: 'platform' },
  low: { tier: 'low', model: HAIKU, ceilingCredits: 5, asksFirst: false, payer: 'workspace' },
  medium: {
    tier: 'medium',
    model: HAIKU,
    ceilingCredits: 30,
    asksFirst: false,
    payer: 'workspace',
  },
  medium_high: {
    tier: 'medium_high',
    model: SONNET,
    ceilingCredits: 120,
    asksFirst: true,
    payer: 'workspace',
  },
  high: { tier: 'high', model: SONNET, ceilingCredits: 400, asksFirst: true, payer: 'workspace' },
});

export function isAiTier(value: string): value is AiTier {
  return (AI_TIERS as readonly string[]).includes(value);
}

/** The owner dashboard's breakdown (plan 62 §5). The vocabulary of `ai_tasks.activity` (0382). */
export const AI_ACTIVITIES = [
  'tasks',
  'clients',
  'time_billing',
  'file_analysis',
  'knowledge',
  'support',
] as const;
export type AiActivity = (typeof AI_ACTIVITIES)[number];

// ── Pools ─────────────────────────────────────────────────────────────────────

/** The vocabulary of `ai_budget_pools.pool` (0381). */
export const AI_POOLS = ['customers', 'testing', 'reserve', 'packs'] as const;
export type AiPool = (typeof AI_POOLS)[number];

/** The pools a caller can ever draw from. Reserve is released only by a platform admin (62-08). */
export type AiSpendingPool = Extract<AiPool, 'customers' | 'testing'>;

/**
 * Each pool's share of the platform ceiling, in percent (plan 62 §5: 60 / 25 / 15 of 100 USD).
 * Packs start at 0 and grow only by the cost value of packs actually paid (phase 6).
 */
export const AI_POOL_SHARE_PERCENT: Readonly<Record<AiPool, number>> = Object.freeze({
  customers: 60,
  testing: 25,
  reserve: 15,
  packs: 0,
});

/** Sonnet is switched off once the customer pool passes this share of its cap (plan 62 §4.2). */
export const SONNET_CUSTOMER_POOL_LIMIT_PERCENT = 80;

/**
 * The share of a pool's cap a call of `model` may fill from `pool`: 100 except Sonnet on customers,
 * which stops at {@link SONNET_CUSTOMER_POOL_LIMIT_PERCENT} — or at 0 while the platform admin's
 * Sonnet switch is off (62-08). The testing pool keeps Sonnet either way (the benchmark needs it).
 */
export function poolLimitPercentFor(
  pool: AiSpendingPool,
  model: AiModelId,
  sonnetEnabled = true,
): number {
  if (pool !== 'customers' || model !== SONNET) return 100;
  return sonnetEnabled ? SONNET_CUSTOMER_POOL_LIMIT_PERCENT : 0;
}

/** The monthly cap of each pool, in micro-USD, from the platform ceiling. Never sums above it. */
export function poolCapsMicroUsd(platformCapMicroUsd: number): Readonly<Record<AiPool, number>> {
  const share = (pool: AiPool) =>
    Math.floor((platformCapMicroUsd * AI_POOL_SHARE_PERCENT[pool]) / 100);
  return Object.freeze({
    customers: share('customers'),
    testing: share('testing'),
    reserve: share('reserve'),
    packs: share('packs'),
  });
}

// ── Who may spend, and from which pool ────────────────────────────────────────

/** The named system jobs that may spend (plan 62 §5). Everything else without a member is refused. */
export type AiSystemJob = 'benchmark' | 'digest_wording';

/** The workspace's platform-set AI settings (`ai_workspace_settings`, 0383); no row = defaults. */
export interface AiWorkspaceStanding {
  readonly poolClass: AiSpendingPool;
  /** `test_list_at` is set: the first gate before any spend. */
  readonly onTestList: boolean;
}

/**
 * The caller's class, as the server determined it. Never read from a request.
 *
 * - `member`: an interactive request of a signed-in internal member on an ordinary session.
 * - `system_job`: a named platform job running under a service context.
 * - `refused`: workers, automations, MCP principals (personal-access-token channel), plan-60
 *   agents, clients and guests. They can never take a hold.
 */
export type AiCallerClass =
  | { readonly kind: 'member' }
  | { readonly kind: 'system_job'; readonly job: AiSystemJob }
  | { readonly kind: 'refused' };

export type AiPoolChoice =
  | { readonly ok: true; readonly pool: AiSpendingPool; readonly payer: AiPayer }
  | { readonly ok: false; readonly reason: 'caller_not_allowed' | 'not_on_test_list' };

/**
 * The pool a task draws from and who pays its credits. The benchmark always draws from testing;
 * every other caller from the workspace's pool class, and only when the workspace is on the test
 * list. A system job and the free help tier never debit the workspace.
 */
export function choosePool(
  caller: AiCallerClass,
  standing: AiWorkspaceStanding,
  tier: AiTier,
): AiPoolChoice {
  if (caller.kind === 'refused') return { ok: false, reason: 'caller_not_allowed' };
  if (caller.kind === 'system_job' && caller.job === 'benchmark') {
    return { ok: true, pool: 'testing', payer: 'platform' };
  }
  if (!standing.onTestList) return { ok: false, reason: 'not_on_test_list' };
  const payer = caller.kind === 'system_job' ? 'platform' : AI_TIER_SPECS[tier].payer;
  return { ok: true, pool: standing.poolClass, payer };
}

// ── Per-member daily limits and hold timing ───────────────────────────────────

/** Free help answers a member may get per day before help search answers without AI (plan 62 §5). */
export const FREE_SUPPORT_PER_MEMBER_PER_DAY = 20;

/** Undo refunds a member may get per day; stops do-undo loops (plan 62 §5). */
export const REFUNDS_PER_MEMBER_PER_DAY = 5;

/** How long a call's hold lives before the expiry sweep treats the call as lost. */
export const AI_CALL_HOLD_TTL_MS = 15 * 60 * 1000;

/** A task still running this long after it started is closed as failed (platform pays). */
export const AI_TASK_TTL_MS = 60 * 60 * 1000;

// ── The platform ceiling ──────────────────────────────────────────────────────

/** `AI_PLATFORM_CAP_MAX_USD` when unset (plan 62 §5). */
export const AI_PLATFORM_CAP_DEFAULT_USD = 100;

export class AiBudgetConfigError extends Error {
  override readonly name = 'AiBudgetConfigError';
}

/**
 * The platform's monthly ceiling over every pool, in micro-USD, from `AI_PLATFORM_CAP_MAX_USD`
 * (USD, up to two decimals). Unset or blank = {@link AI_PLATFORM_CAP_DEFAULT_USD}. Anything else
 * that is not a positive amount is refused rather than guessed, so a typo can never raise the cap.
 */
export function platformCapMicroUsd(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env['AI_PLATFORM_CAP_MAX_USD']?.trim() ?? '';
  if (raw === '') return AI_PLATFORM_CAP_DEFAULT_USD * 1_000_000;
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(raw)) {
    throw new AiBudgetConfigError('AI_PLATFORM_CAP_MAX_USD must be a USD amount like 100 or 99.50');
  }
  const [whole = '0', cents = ''] = raw.split('.');
  const microUsd = Number(whole) * 1_000_000 + Number(cents.padEnd(2, '0')) * 10_000;
  if (microUsd <= 0) throw new AiBudgetConfigError('AI_PLATFORM_CAP_MAX_USD must be above 0');
  return microUsd;
}
