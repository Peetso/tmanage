/**
 * **The size and shape caps on a body sent to this package's Streamable HTTP listener (audit run
 * 3, M02, GHSA-mrhx-c7xc-m3w5).**
 *
 * zod 3 kept validating every element of an array (and every key of a record) after a `.max()`
 * had already failed, so an oversized collection cost memory in proportion to its length, not to
 * the schema's limit. Wave 13 moved to zod 4.6.x, which fixes that; this cap stays as a second
 * line. The MCP SDK parses every JSON-RPC message with zod, so the listener caps the
 * body's size and shape before the SDK sees it.
 *
 * This is a local copy of the rules in `apps/api/src/modules/mcp/mcp-body-shape.ts` (same
 * constants, same walk): this package ships on its own and must not import from the API. Keep the
 * two in step.
 *
 * The walk is iterative and stops at the first excess, so its own cost is bounded by the caps.
 */

/** The most bytes a request body may carry, the same as the API's Fastify body limit (1 MiB). */
export const MCP_MAX_BODY_BYTES = 1_048_576;

/** No array in an MCP body may hold more items than this (the largest schema `.max()` is 500). */
export const MCP_MAX_ARRAY_ITEMS = 1_000;

/** No object in an MCP body may hold more keys than this. */
export const MCP_MAX_OBJECT_KEYS = 1_000;

/** Every value and key in the body together, counted once each. */
export const MCP_MAX_JSON_VALUES = 20_000;

/** How deep arrays and objects may nest. */
export const MCP_MAX_DEPTH = 32;

export type McpBodyShapeRefusal =
  'array_too_long' | 'object_too_wide' | 'too_many_values' | 'too_deep';

/** `undefined` when the body is within every cap; otherwise the first cap it broke. */
export function mcpBodyShapeRefusal(body: unknown): McpBodyShapeRefusal | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: body, depth: 0 }];
  let values = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    values += 1;
    if (values > MCP_MAX_JSON_VALUES) return 'too_many_values';
    if (value === null || typeof value !== 'object') continue;
    if (depth >= MCP_MAX_DEPTH) return 'too_deep';
    if (Array.isArray(value)) {
      if (value.length > MCP_MAX_ARRAY_ITEMS) return 'array_too_long';
      if (values + value.length > MCP_MAX_JSON_VALUES) return 'too_many_values';
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
      continue;
    }
    const keys = Object.keys(value);
    if (keys.length > MCP_MAX_OBJECT_KEYS) return 'object_too_wide';
    // A key is a value zod validates too (`z.record` key schemas).
    values += keys.length;
    if (values > MCP_MAX_JSON_VALUES) return 'too_many_values';
    for (const key of keys) {
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  return undefined;
}
