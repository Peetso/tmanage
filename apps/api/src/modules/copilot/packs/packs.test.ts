import { describe, expect, it } from 'vitest';
import { findOpById, isNever } from '../../ai-actions/registry/index.js';
import { allDetailsById } from '../../mcp/tool-catalog.js';
import { CHAT_TOOLS, isAiSelfOp, planToolCall } from '../ai-chat-tools.js';
import { AI_DOMAINS } from '../ai-router.js';
import { HELP_PREFIX } from '../help-prefix.js';
import { domainSystemPrompt } from '../system-prompts/domains.js';
import { PACK_MAX_TOOLS, PACK_MIN_TOOLS, PACK_OPS, packOpFor, packTools } from './index.js';
import { STRICT_LIMITS } from '../ai-client.js';
import { dropNulls, packToolSchema } from './pack-schema.js';

/**
 * 62-10 (plan 62 §4.1 step 4, §9 row) — every pack tool maps to one registry op; packs are 8–15
 * non-strict tools with closed schemas generated from the op's own schema; the prefix is constant.
 */

function assertClosed(node: unknown, path: string): void {
  if (typeof node !== 'object' || node === null) return;
  const schema = node as Record<string, unknown>;
  if (schema['type'] === 'object') {
    expect(schema['additionalProperties'], path).toBe(false);
    const properties = schema['properties'] as Record<string, unknown>;
    for (const name of schema['required'] as string[])
      expect(properties, path).toHaveProperty(name);
    for (const [key, child] of Object.entries(properties)) assertClosed(child, `${path}.${key}`);
  }
  for (const child of (schema['anyOf'] as unknown[] | undefined) ?? []) assertClosed(child, path);
  if (schema['items'] !== undefined) assertClosed(schema['items'], `${path}[]`);
}

describe('domain packs v1', () => {
  it('every pack tool maps to exactly one registry op with a detail; never NEVER or the AI itself', () => {
    for (const [domain, ids] of Object.entries(PACK_OPS)) {
      expect(ids!.length, domain).toBeGreaterThanOrEqual(PACK_MIN_TOOLS);
      expect(ids!.length, domain).toBeLessThanOrEqual(PACK_MAX_TOOLS);
      expect(new Set(ids).size, domain).toBe(ids!.length);
      for (const id of ids!) {
        const op = findOpById(id);
        expect(op, id).toBeDefined();
        expect(allDetailsById.has(id), id).toBe(true);
        expect(isNever(op!.method, op!.path), id).toBe(false);
        expect(isAiSelfOp(op!), id).toBe(false);
      }
      const tools = packTools(domain as never);
      for (const tool of tools) {
        expect(packOpFor(tool.name)?.id).toBe(ids![tools.indexOf(tool)]);
        assertClosed(tool.inputSchema, tool.name);
        expect(tool.strict, tool.name).toBe(false);
      }
    }
  });

  it('tool names never clash with the meta-tools or across packs', () => {
    const meta = new Set(CHAT_TOOLS.map((t) => t.name));
    const all = Object.keys(PACK_OPS).flatMap((d) => packTools(d as never).map((t) => t.name));
    expect(all.some((n) => meta.has(n))).toBe(false);
    for (const name of all) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('a pack call is planned as run_action of its op; nulls mean "not given"', () => {
    expect(planToolCall('work_items_list', { projectId: 'prj_1', limit: null })).toMatchObject({
      kind: 'run',
      opId: 'work_items.list',
      args: { action_id: 'work_items.list', args: { projectId: 'prj_1' } },
    });
    expect(
      planToolCall('work_items_update', { workItemId: 'wi_1', title: 'x', dueAt: null }),
    ).toEqual({
      kind: 'change',
      opId: 'work_items.update',
      rawArgs: { workItemId: 'wi_1', title: 'x' },
    });
    expect(dropNulls({ a: null, b: { c: null, d: 1 } })).toEqual({ b: { d: 1 } });
  });

  it('optional fields are left out of required, never nullable; validation stays on the server', () => {
    const schema = packToolSchema(allDetailsById.get('work_items.update')!.input);
    expect(schema.properties['workItemId']).toMatchObject({ type: 'string' });
    expect(schema.required).toContain('workItemId');
    expect(schema.required).not.toContain('title');
    expect(schema.properties['title']).toEqual({ type: 'string' });
    expect(JSON.stringify(schema)).not.toMatch(/maxLength|minLength|minimum|maximum|pattern/);
  });

  it('the strict tools of an answer call stay inside the API limits (2026-11-23 live 400)', () => {
    const strictTools = CHAT_TOOLS.filter((tool) => tool.strict !== false);
    expect(strictTools.length).toBeLessThanOrEqual(STRICT_LIMITS.tools);
    expect(JSON.stringify(strictTools)).not.toMatch(/anyOf|"type":\[/);
  });

  it('the prefix (tools + system) is constant: the same bytes every time, for every workspace', () => {
    const prefix = (domain: (typeof AI_DOMAINS)[number]) =>
      JSON.stringify({ system: domainSystemPrompt(domain), tools: packTools(domain) });
    for (const domain of AI_DOMAINS) expect(prefix(domain)).toBe(prefix(domain));
    // The help prefix holds no data: it is built from the command palette only.
    expect(HELP_PREFIX).toContain('- Home: /home');
    expect(domainSystemPrompt('help')).toBe(HELP_PREFIX);
  });
});
