import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { AiConnectorsService } from '../oauth/ai-connectors.js';
import { keySummaries } from './connections.repository.js';

/**
 * 60-07 — how each AI employee is connected, for People (S1 "Not connected") and the hire
 * wizard's test step (S4 "has he called yet"): its live credentials and its latest call.
 *
 * Two kinds of credential count, together, against the cap of three live credentials: agent keys
 * (`personal_access_tokens` whose membership is the AI employee's) and connectors that work as it
 * (OAuth grants bound to its membership, "works as" on the consent page; read through the OAuth
 * module's `AiConnectorsService`, which owns those tables). `lastCalledAt` is the latest use of
 * either kind.
 */

export interface ConnectionSummary {
  readonly live: number;
  readonly lastCalledAt: Date | null;
}

export const NOT_CONNECTED: ConnectionSummary = Object.freeze({ live: 0, lastCalledAt: null });

const connectors = new AiConnectorsService();

/** Two reads for the whole list (keys, connectors), never one per row. Keyed by membership id. */
export async function connectionSummaries(
  runner: TenantQueryRunner,
  context: TenantContext,
  membershipIds: readonly string[],
  at: Date,
): Promise<ReadonlyMap<string, ConnectionSummary>> {
  const out = new Map<string, ConnectionSummary>();
  if (membershipIds.length === 0) return out;
  for (const [membershipId, keys] of await keySummaries(runner, context, membershipIds, at)) {
    out.set(membershipId, keys);
  }
  const granted = await connectors.summaries(runner, context, membershipIds);
  for (const [membershipId, connector] of granted) {
    const keys = out.get(membershipId) ?? NOT_CONNECTED;
    out.set(membershipId, {
      live: keys.live + connector.live,
      lastCalledAt: latest(keys.lastCalledAt, connector.lastUsedAt),
    });
  }
  return out;
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

/**
 * 60-05 / 60-07 "who may bind" (plan 60 v2 §4.5): the AI employee's sponsor, or a member holding
 * `ai_employee.manage`. The one rule for keys, connectors and the consent page's choice.
 */
export function mayBindAiEmployee(context: TenantContext, sponsorMembershipId: string): boolean {
  return (
    context.membershipId === sponsorMembershipId ||
    context.capabilities.includes('ai_employee.manage')
  );
}
