import type { AiRequest, AiStrictSchema, AiToolDefinition } from './ai-client.js';
import type { AiResponse } from './ai-response.js';
import { AI_TIER_SPECS, isAiTier, type AiActivity, type AiTier } from './ai-tiers.js';
import { ROUTER_SYSTEM_PROMPT } from './system-prompts/router.js';

/**
 * 62-09 (plan 62 §4.1 step 3) — the Haiku router: one short call with one strict tool, `route`,
 * that names the domain and the tier of the member's message. The answer is parsed here once
 * (IP-2): anything but exactly one valid `route` call is "no route", and the orchestrator then
 * stops without spending more. The router never picks the model: the tier does (§4.2).
 */

export const AI_DOMAINS = [
  'tasks',
  'projects',
  'people',
  'clients',
  'time',
  'billing',
  'files',
  'help',
] as const;
export type AiDomain = (typeof AI_DOMAINS)[number];

export function isAiDomain(value: unknown): value is AiDomain {
  return typeof value === 'string' && (AI_DOMAINS as readonly string[]).includes(value);
}

export interface AiRoute {
  readonly domain: AiDomain;
  readonly tier: AiTier;
}

/** The router's own reply budget: one tool call with two short strings. */
export const ROUTER_MAX_TOKENS = 128;

export const ROUTE_TOOL_NAME = 'route';

const ROUTE_SCHEMA: AiStrictSchema = {
  type: 'object',
  properties: {
    domain: { type: 'string', enum: [...AI_DOMAINS] },
    tier: { type: 'string', enum: Object.keys(AI_TIER_SPECS) },
  },
  required: ['domain', 'tier'],
  additionalProperties: false,
};

const ROUTE_TOOL: AiToolDefinition = {
  name: ROUTE_TOOL_NAME,
  description: 'Name the domain and the cheapest tier for the message.',
  inputSchema: ROUTE_SCHEMA,
  cache: '1h',
};

/** The router call for one message. The prompt and tool are the same for every workspace. */
export function routerRequest(message: string): AiRequest {
  return {
    model: AI_TIER_SPECS.low.model,
    maxTokens: ROUTER_MAX_TOKENS,
    effort: 'low',
    system: [{ text: ROUTER_SYSTEM_PROMPT, cache: '1h' }],
    tools: [ROUTE_TOOL],
    messages: [{ role: 'user', content: message }],
  };
}

/** Exactly one `route` call with a known domain and tier, else `null`. */
export function parseRoute(response: Pick<AiResponse, 'content'>): AiRoute | null {
  const calls = response.content.filter(
    (block) => block.type === 'tool_use' && block.name === ROUTE_TOOL_NAME,
  );
  if (calls.length !== 1) return null;
  const call = calls[0];
  if (call === undefined || call.type !== 'tool_use') return null;
  const { domain, tier } = call.input;
  if (!isAiDomain(domain) || typeof tier !== 'string' || !isAiTier(tier)) return null;
  // Help is free support only as a help question; a help *tier* elsewhere is read as low.
  if (domain === 'help') return { domain, tier: 'help' };
  return { domain, tier: tier === 'help' ? 'low' : tier };
}

/** The owner dashboard's activity (`ai_tasks.activity`) of a domain. */
export function activityOf(domain: AiDomain): AiActivity {
  switch (domain) {
    case 'clients':
      return 'clients';
    case 'time':
    case 'billing':
      return 'time_billing';
    case 'files':
      return 'knowledge';
    case 'help':
      return 'support';
    default:
      return 'tasks';
  }
}
