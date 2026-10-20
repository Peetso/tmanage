import { describe, expect, it } from 'vitest';
import { OPS, opsById, neverByKey, routeKey } from './index.js';
import { REDACT_PROFILES } from './detail.js';
import { waveADetails, waveADetailsById } from './wave-a.js';

/**
 * Slice S2 (registry wave A) — the enrichment layer for work (items/forms), projects, search,
 * home, inbox, the notifications feed and work views. This test is the slice's guard: it proves
 * every wave-A op has exactly one detail, no detail points at a non-op or a NEVER route, every
 * input schema accepts its own worked example and rejects stray keys, `:orgSlug` is never an
 * accepted argument (the tenant comes from the grant — architecture B3/T-TEN-01), and the
 * send/notify ops carry `notifies` (→ `openWorldHint`). It is keyed off the live `OPS`, so it stays
 * correct if S1's classification shifts rather than hard-coding counts. `notification_preferences.*`
 * is intentionally excluded here — it belongs to wave C (S4).
 */

/** The op-id prefixes that belong to registry wave A (plan §7, S2). */
const WAVE_A_PREFIXES = [
  'work_items',
  'work_forms',
  'work',
  'projects',
  'search',
  'home',
  'inbox',
  'notifications',
  'work_views',
] as const;

function isWaveA(id: string): boolean {
  // `notifications` matches the feed but must not swallow wave-C `notification_preferences.*`.
  if (id === 'notification_preferences' || id.startsWith('notification_preferences.')) return false;
  return WAVE_A_PREFIXES.some((p) => id === p || id.startsWith(`${p}.`));
}

const waveAOpIds = OPS.map((op) => op.id).filter(isWaveA);

describe('AI action registry — wave A details (S2)', () => {
  it('has a detail for every wave-A op, and no duplicates', () => {
    const missing = waveAOpIds.filter((id) => !waveADetailsById.has(id));
    expect(missing, `wave-A ops with no detail:\n${missing.join('\n')}`).toEqual([]);
    // indexById throws on a duplicate id, so equal sizes prove a 1:1 array↔map mapping.
    expect(waveADetailsById.size).toBe(waveADetails.length);
    expect(waveADetails.length).toBe(waveAOpIds.length);
  });

  it('never enriches a non-op or a NEVER route', () => {
    const orphans: string[] = [];
    for (const d of waveADetails) {
      const op = opsById.get(d.id);
      if (!op) {
        orphans.push(`${d.id} (no such op)`);
        continue;
      }
      if (neverByKey.has(routeKey(op.method, op.path))) orphans.push(`${d.id} (route is NEVER)`);
    }
    expect(orphans, `detail ids that are not live ops:\n${orphans.join('\n')}`).toEqual([]);
  });

  it('well-forms every detail (profile, flags, prose, schema)', () => {
    for (const d of waveADetails) {
      expect(REDACT_PROFILES, d.id).toContain(d.redact);
      expect(typeof d.notifies, d.id).toBe('boolean');
      expect(d.title.length, d.id).toBeGreaterThan(0);
      expect(d.description.length, d.id).toBeGreaterThan(0);
      expect(typeof d.input.safeParse, d.id).toBe('function');
      expect(d.examples.length, `${d.id} has no example`).toBeGreaterThan(0);
    }
  });

  it('accepts each worked example against its own input schema', () => {
    const bad: string[] = [];
    for (const d of waveADetails) {
      for (const ex of d.examples) {
        const r = d.input.safeParse(ex.args);
        if (!r.success) bad.push(`${d.id}: ${JSON.stringify(ex.args)} -> ${r.error.message}`);
      }
    }
    expect(bad, `examples rejected by their schema:\n${bad.join('\n')}`).toEqual([]);
  });

  it('rejects unknown keys on a strict write (injection surface, architecture B3/T-INJ)', () => {
    const create = waveADetailsById.get('work_items.create');
    expect(create).toBeDefined();
    expect(create!.input.safeParse({ title: 'X', sneaky: 1 }).success).toBe(false);
  });

  it('never accepts :orgSlug as an argument (tenant is bound by the grant)', () => {
    // A strict schema rejects the extra key outright; a passthrough schema ignores (drops) it.
    // Either way `orgSlug` must never survive as a model-chosen value, so no example carries it.
    const carriesOrgSlug = waveADetails.filter((d) =>
      d.examples.some((ex) => Object.prototype.hasOwnProperty.call(ex.args, 'orgSlug')),
    );
    expect(
      carriesOrgSlug.map((d) => d.id),
      'examples must not pass orgSlug',
    ).toEqual([]);

    const list = waveADetailsById.get('work_items.list');
    expect(list!.input.safeParse({ orgSlug: 'acme' }).success).toBe(false);
  });

  it('flags the notify ops with openWorldHint (notifies)', () => {
    for (const id of [
      'work_items.comments.create',
      'projects.updates.create',
      'projects.status_updates.create',
      'projects.updates.comments.create',
    ]) {
      expect(waveADetailsById.get(id)?.notifies, id).toBe(true);
    }
    // A plain read must never be a notification.
    expect(waveADetailsById.get('work_items.list')?.notifies).toBe(false);
  });
});
