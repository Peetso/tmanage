import { z } from 'zod';
import type { AiStrictSchema } from '../ai-client.js';
import type { JsonObject } from '../ai-response.js';

/**
 * 62-10 (plan 62 §4.1 step 4) — a pack tool's input schema generated from a registry op's own zod
 * input schema (IP-2: one schema; the pack never restates it). The model gets the shape; the server
 * still validates with the op's schema before anything runs, so constraints the tool does not need
 * (lengths, ranges, patterns, formats) are left out of the tool and enforced there.
 *
 * Every object closes (`additionalProperties: false`); a required field is listed in `required`
 * and an optional one is simply left out of it. Pack tools are sent NON-strict (2026-11-23): the
 * API caps all strict schemas of one request together at 16 union-typed and 24 optional
 * parameters, and the earlier required-but-nullable form put 39 unions in one request, so every
 * answer call failed with a 400. A `null` the model still sends is dropped before validation
 * ({@link dropNulls}).
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
    const closedProps: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(properties)) closedProps[name] = strictNode(child);
    out['properties'] = closedProps;
    out['required'] = Object.keys(closedProps).filter((name) => required.has(name));
    out['additionalProperties'] = false;
  }
  return out as JsonObject;
}

/** The pack tool schema of an op's input schema (an object schema; anything else = no args). */
export function packToolSchema(input: z.ZodTypeAny): AiStrictSchema {
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
