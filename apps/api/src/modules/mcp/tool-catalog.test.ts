import { describe, expect, it } from 'vitest';
import { OPS } from '../ai-actions/registry/index.js';
import type { AiScope } from '../ai-actions/registry/index.js';
import {
  COMPACT_CORE_OP_IDS,
  allDetailsById,
  annotationsForOp,
  buildToolCatalog,
  capabilitySatisfied,
  effectiveScopes,
  scopeSatisfied,
  toolNameForOp,
} from './tool-catalog.js';

const ALL_SCOPES: readonly AiScope[] = ['read', 'write', 'manage', 'billing'];
const ALL_CAPS: ReadonlySet<string> = new Set<string>(
  OPS.map((op) => op.capability).filter((c): c is NonNullable<typeof c> => c !== null),
);

describe('scope expansion (plan §4.2)', () => {
  it('manage implies write and read; billing stays independent', () => {
    expect([...effectiveScopes(['manage'])].sort()).toEqual(['manage', 'read', 'write']);
    expect(scopeSatisfied(['manage'], 'read')).toBe(true);
    expect(scopeSatisfied(['manage'], 'write')).toBe(true);
    expect(scopeSatisfied(['manage'], 'billing')).toBe(false);
    expect(scopeSatisfied(['read'], 'write')).toBe(false);
    expect(scopeSatisfied(['billing'], 'read')).toBe(false);
  });
});

describe('capabilitySatisfied', () => {
  it('allows a null capability and gates a named one', () => {
    expect(capabilitySatisfied(new Set(), null)).toBe(true);
    expect(capabilitySatisfied(new Set(['work.read']), 'work.read')).toBe(true);
    expect(capabilitySatisfied(new Set(['doc.read']), 'work.read')).toBe(false);
  });
});

describe('toolNameForOp', () => {
  it('turns the dotted op id into an underscore tool name', () => {
    expect(toolNameForOp('work_items.comments.create')).toBe('work_items_comments_create');
  });
});

describe('annotationsForOp', () => {
  it('marks a read as read-only and idempotent, not destructive', () => {
    const op = OPS.find((o) => o.id === 'work_items.list')!;
    const ann = annotationsForOp(op, allDetailsById.get(op.id)!);
    expect(ann).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
  });

  it('marks a DELETE as destructive', () => {
    const del = OPS.find((o) => o.method === 'DELETE' && allDetailsById.has(o.id))!;
    const ann = annotationsForOp(del, allDetailsById.get(del.id)!);
    expect(ann.destructiveHint).toBe(true);
    expect(ann.readOnlyHint).toBe(false);
  });
});

describe('buildToolCatalog — compact', () => {
  const catalog = buildToolCatalog({
    profile: 'compact',
    scopes: ALL_SCOPES,
    capabilities: ALL_CAPS,
  });

  it('includes every curated core op plus the four meta-tools', () => {
    const names = new Set(catalog.tools.map((t) => t.name));
    for (const id of COMPACT_CORE_OP_IDS) {
      expect(names.has(toolNameForOp(id))).toBe(true);
    }
    for (const meta of [
      'tmanage_find_actions',
      'tmanage_describe_action',
      'tmanage_run_action',
      'tmanage_check_approval',
    ]) {
      expect(names.has(meta)).toBe(true);
    }
    expect(catalog.tools.length).toBe(COMPACT_CORE_OP_IDS.length + 4);
  });

  it('serves the two resources and three prompts', () => {
    expect(catalog.resources.map((r) => r.name).sort()).toEqual(['me-today', 'project-context']);
    expect(catalog.prompts.map((p) => p.name).sort()).toEqual([
      'plan-my-day',
      'project-status-update',
      'triage-inbox',
    ]);
  });

  it('resolves every core id to an op that carries a detail', () => {
    for (const id of COMPACT_CORE_OP_IDS) {
      expect(OPS.some((o) => o.id === id)).toBe(true);
      expect(allDetailsById.has(id)).toBe(true);
    }
  });
});

describe('buildToolCatalog — full, filtered by scope and capability (T-SCP-01)', () => {
  it('a read-only grant lists only read ops', () => {
    const catalog = buildToolCatalog({ profile: 'full', scopes: ['read'], capabilities: ALL_CAPS });
    const byName = new Map(OPS.map((o) => [toolNameForOp(o.id), o] as const));
    expect(catalog.tools.length).toBeGreaterThan(0);
    for (const tool of catalog.tools) {
      expect(byName.get(tool.name)?.risk).toBe('read');
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it('a write grant adds write ops but still no confirm/manage-only or billing ops', () => {
    const readOnly = buildToolCatalog({
      profile: 'full',
      scopes: ['read'],
      capabilities: ALL_CAPS,
    });
    const write = buildToolCatalog({ profile: 'full', scopes: ['write'], capabilities: ALL_CAPS });
    expect(write.tools.length).toBeGreaterThan(readOnly.tools.length);
    const byName = new Map(OPS.map((o) => [toolNameForOp(o.id), o] as const));
    for (const tool of write.tools) {
      const op = byName.get(tool.name)!;
      expect(op.scope === 'read' || op.scope === 'write').toBe(true);
    }
  });

  it('omits a tool whose capability the member lacks', () => {
    const withCap = buildToolCatalog({
      profile: 'full',
      scopes: ALL_SCOPES,
      capabilities: ALL_CAPS,
    });
    const withoutDoc = buildToolCatalog({
      profile: 'full',
      scopes: ALL_SCOPES,
      capabilities: new Set([...ALL_CAPS].filter((c) => c !== 'doc.read')),
    });
    expect(withCap.tools.some((t) => t.name === 'documents_list')).toBe(true);
    expect(withoutDoc.tools.some((t) => t.name === 'documents_list')).toBe(false);
  });
});
