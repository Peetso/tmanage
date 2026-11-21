import { z } from 'zod';
import type { AiStrictSchema } from '../ai-client.js';
import type { JsonObject } from '../ai-response.js';

/**
 * 62-10 (plan 62 §4.1 step 4) — a strict tool schema generated from a registry op's own zod input
 * schema (IP-2: one schema; the pack never restates it). The model gets the shape; the server
 * still validates with the op's schema before anything runs, so constraints the strict tool format
 * does not need (lengths, ranges, patterns, formats) are left out of the tool and enforced there.
 *
 * Strict means: every object closes (`additionalProperties: false`) and names every property in
 * `required`; an optional field is required-but-nullable (`anyOf [type, null]`), and a `null` the
 * model sends is dropped before validation ({@link dropNulls}).
 */

const KEEP = new Set(['type', 'properties', 'items', 'enum', 'const', 'anyOf', 'description']);

function strictNode(node: unknown): JsonObject {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return {};
  const source = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!KEEP.has(key)) continue;
    if (key === 'properties' || key === 'items' || key === 'anyOf') continue;
    out[key] = value;
  }
  if (Array.isArray(source['anyOf'])) out['anyOf'] = source['anyOf'].map(strictNode);
  if (source['items'] !== undefined) out['items'] = strictNode(source['items']);
  if (source['type'] === 'object') {
    const properties = (source['properties'] ?? {}) as Record<string, unknown>;
    const required = new Set(
      Array.isArray(source['required']) ? (source['required'] as string[]) : [],
    );
    const strictProps: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(properties)) {
      const strict = strictNode(child);
      strictProps[name] = required.has(name) ? strict : { anyOf: [strict, { type: 'null' }] };
    }
    out['properties'] = strictProps;
    out['required'] = Object.keys(strictProps);
    out['additionalProperties'] = false;
  }
  return out as JsonObject;
}

/** The strict tool schema of an op's input schema (an object schema; anything else = no args). */
export function strictToolSchema(input: z.ZodTypeAny): AiStrictSchema {
  const json = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' });
  const strict = strictNode(json);
  if (strict['type'] !== 'object') {
    return { type: 'object', properties: {}, required: [], additionalProperties: false };
  }
  return strict as unknown as AiStrictSchema;
}

/** The arguments without the `null`s that stand for "not given" (objects only, recursively). */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, dropNulls(v)]),
  );
}
