import type { AiToolDefinition } from '../ai-client.js';

/**
 * 62-26 (plan 62 §4.6) — `recall_business_memory`: the approved Business Memory facts about the
 * entities of this turn (op `business_memory.facts.recall`, `GET …/business-memory/recall`). The
 * route filters by audience and entity before ordering and re-checks every fact, and returns at
 * most eight. The facts are text people wrote, so they reach the model wrapped as untrusted data
 * (the op id matches `untrusted-sources.ts`) and taint the turn: a fact that says "ignore your
 * rules" stays a quoted fact. Tool results sit after the request's cache breakpoint (system and
 * tools are the cached prefix), so recalled facts never change the cached part.
 *
 * Proposing a fact is the registry's confirm-class `business_memory.facts.propose`, reached through
 * `run_action`: the member always sees a card, and the fact is not recalled until a person approves.
 */

export const RECALL_MEMORY_TOOL = 'recall_business_memory';
export const RECALL_MEMORY_OP = 'business_memory.facts.recall';
const MAX_ENTITIES = 5;
const ENTITY_TYPES = ['client', 'project', 'person', 'process', 'company'] as const;

export const RECALL_MEMORY_TOOL_DEFINITION: AiToolDefinition = Object.freeze({
  name: RECALL_MEMORY_TOOL,
  description:
    'Recall the approved Business Memory facts (lasting preferences, policies, contacts, ' +
    'billing and delivery rules) about the clients, projects, people, processes or the company ' +
    'this question is about. At most eight facts; quote them as facts the workspace keeps.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['entities'],
    properties: {
      entities: {
        type: 'array',
        description: 'Up to five entities; id is null for process and company.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'id'],
          properties: {
            type: { type: 'string', enum: [...ENTITY_TYPES] },
            id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      },
    },
  },
}) as AiToolDefinition;

/** The recall route's `entities` parameter, or `null` when the call names none. */
export function recallArgs(
  input: Readonly<Record<string, unknown>>,
): { readonly entities: string } | null {
  const raw = input['entities'];
  if (!Array.isArray(raw)) return null;
  const parts: string[] = [];
  for (const item of raw.slice(0, MAX_ENTITIES)) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const type = entry['type'];
    if (typeof type !== 'string' || !(ENTITY_TYPES as readonly string[]).includes(type)) continue;
    const id = entry['id'];
    if (type === 'process' || type === 'company') parts.push(type);
    else if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) parts.push(`${type}:${id}`);
  }
  return parts.length === 0 ? null : { entities: [...new Set(parts)].join(',') };
}

interface RecalledFact {
  readonly entityType: string;
  readonly entityId: string | null;
  readonly category: string;
  readonly fact: string;
  readonly lastConfirmedAt: string | null;
  readonly stale: boolean;
  readonly sourceHref: string | null;
}

function factsOf(data: unknown, depth = 0): readonly RecalledFact[] | null {
  if (typeof data === 'string') {
    try {
      return factsOf(JSON.parse(data), depth);
    } catch {
      return null;
    }
  }
  if (typeof data !== 'object' || data === null || depth > 3) return null;
  const record = data as Record<string, unknown>;
  const facts = record['facts'];
  if (Array.isArray(facts)) {
    return facts.flatMap((raw): RecalledFact[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const fact = raw as Record<string, unknown>;
      if (typeof fact['fact'] !== 'string' || typeof fact['entityType'] !== 'string') return [];
      return [
        {
          entityType: fact['entityType'],
          entityId: typeof fact['entityId'] === 'string' ? fact['entityId'] : null,
          category: typeof fact['category'] === 'string' ? fact['category'] : 'other',
          fact: fact['fact'],
          lastConfirmedAt:
            typeof fact['lastConfirmedAt'] === 'string' ? fact['lastConfirmedAt'] : null,
          stale: fact['stale'] === true,
          sourceHref: typeof fact['sourceHref'] === 'string' ? fact['sourceHref'] : null,
        },
      ];
    });
  }
  for (const key of ['data', 'body', 'result']) {
    const inner = factsOf(record[key], depth + 1);
    if (inner !== null) return inner;
  }
  return null;
}

/**
 * The facts as numbered lines: `[n] client <id> | billing | confirmed 2026-…` and the fact, with
 * "not confirmed for 180 days" on a stale one. `null` when the result is not a fact list.
 */
export function recalledFactSources(data: unknown): string | null {
  const facts = factsOf(data);
  if (facts === null) return null;
  if (facts.length === 0) return 'No approved Business Memory facts about these.';
  return facts
    .map((fact, index) => {
      const head = [
        `[${String(index + 1)}] ${fact.entityType}${fact.entityId === null ? '' : ` ${fact.entityId}`}`,
        fact.category,
        ...(fact.lastConfirmedAt === null
          ? []
          : [`confirmed ${fact.lastConfirmedAt.slice(0, 10)}`]),
        ...(fact.stale ? ['not confirmed for 180 days'] : []),
        ...(fact.sourceHref === null ? [] : [fact.sourceHref]),
      ].join(' | ');
      return [head, fact.fact].join(String.fromCodePoint(10));
    })
    .join(String.fromCodePoint(10, 10));
}
