import { SIGNAL_BRIEFING_GROUPS } from '@tmanage/domain';
import type { SignalBriefingGroup } from '@tmanage/domain';
import type { AiToolDefinition } from '../ai-client.js';
import type { AiDomain } from '../ai-router.js';

/**
 * 62-28 (plan 62 §4.8 "AI only on request") — "Explain this alert", a Low turn.
 *
 * The button sends `{ explain: { signalId, group } }` with the chat request. The server then skips
 * the router (the tier is fixed at Low and the domain follows the alert's group, which only picks
 * the read pack the model gets), offers one extra tool, `explain_signal`, and adds the alert id to
 * the member's message. The tool runs `home.briefing.signals.get` as the member: the same
 * per-signal rule as the Home card, so an alert the member may not see is a 404 and the model has
 * nothing to explain. The figures come from that tool only (the answer guard withholds any other).
 * No model is called anywhere else on the signals path (`signals-no-model.test.ts`).
 */

export const EXPLAIN_SIGNAL_TOOL = 'explain_signal';
export const EXPLAIN_SIGNAL_OP = 'home.briefing.signals.get';
export const EXPLAIN_DEFAULT_MESSAGE = 'Explain this alert.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ExplainRequest {
  readonly signalId: string;
  readonly group: SignalBriefingGroup;
}

/** The read pack an alert's explanation gets: where its record lives. */
export const EXPLAIN_DOMAIN: Readonly<Record<SignalBriefingGroup, AiDomain>> = {
  projects_at_risk: 'projects',
  over_budget: 'projects',
  stale_work: 'tasks',
  people_overloaded: 'people',
  waiting_on_clients: 'clients',
  money_to_collect: 'billing',
  money_to_invoice: 'billing',
  unusual_expenses: 'billing',
};

/** The body's `explain`, or `null` when absent; `undefined` when present but not valid. */
export function parseExplain(raw: unknown): ExplainRequest | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const { signalId, group } = record;
  if (Object.keys(record).some((key) => key !== 'signalId' && key !== 'group')) return undefined;
  if (typeof signalId !== 'string' || !UUID.test(signalId)) return undefined;
  if (typeof group !== 'string' || !(SIGNAL_BRIEFING_GROUPS as readonly string[]).includes(group)) {
    return undefined;
  }
  return { signalId: signalId.toLowerCase(), group: group as SignalBriefingGroup };
}

/** The member's words with the alert id the tool needs (ids only, never record text). */
export function explainMessage(message: string, explain: ExplainRequest): string {
  return `${message}${String.fromCodePoint(10, 10)}Alert id: ${explain.signalId}`;
}

export const EXPLAIN_SIGNAL_TOOL_DEFINITION: AiToolDefinition = Object.freeze({
  name: EXPLAIN_SIGNAL_TOOL,
  description:
    'Read one open alert by its id: the rule, the figure it measured, the threshold, the reason ' +
    'in words, the record it is about and its link. Call it first, then explain in plain words ' +
    'why the alert fired and what would clear it, citing the record link. Use only its figures.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['signalId'],
    properties: {
      signalId: { type: 'string', description: 'The alert id from the message.' },
    },
  },
}) as AiToolDefinition;

/** The op's arguments, or `null` for an id that is not one. */
export function explainArgs(
  input: Readonly<Record<string, unknown>>,
): { readonly signalId: string } | null {
  const id = input['signalId'];
  return typeof id === 'string' && UUID.test(id) ? { signalId: id.toLowerCase() } : null;
}
