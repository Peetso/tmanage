import { describe, expect, it } from 'vitest';
import { OPS, opsById, neverByKey, routeKey } from './index.js';
import { REDACT_PROFILES } from './detail.js';
import { waveCDetails, waveCDetailsById } from './wave-c.js';

/**
 * Slice S4 (registry wave C) — the enrichment layer for clients/portal, people, tenancy, insights,
 * preferences, admin, billing, automations, audit and import. This test is the slice's guard: it
 * proves every wave-C op has exactly one detail, no detail points at a non-op or a NEVER route,
 * every input schema accepts its own example and rejects stray keys, and that the PAT routes were
 * finalised into NEVER (architecture B3). It is deliberately keyed off the live `OPS`, so it stays
 * correct if S1's classification shifts, rather than hard-coding counts.
 */

/** The op-id prefixes that belong to registry wave C (plan §7, S4). */
const WAVE_C_PREFIXES = [
  'client_organizations',
  'client_memberships',
  'portal',
  'people',
  'members',
  'invitations',
  'settings',
  'workspaces',
  'insights',
  'preferences',
  'notification_preferences',
  'me',
  'admin',
  'announcements',
  'branding',
  'feature_flags',
  'billing',
  'automations',
  'audit',
  'imports',
  // R18-b: time, timesheets, expenses, rates and retainers (`finance-time.ts`).
  'time',
  'finance',
  // 52-22p: quotes and client invoices (`finance-documents.ts`).
  'quotes',
  'client_invoices',
  // 62-A2: the Activity tab of a project and of a client (`activity.ts`).
  'activity',
] as const;

function isWaveC(id: string): boolean {
  return WAVE_C_PREFIXES.some((p) => id === p || id.startsWith(`${p}.`));
}

const waveCOpIds = OPS.map((op) => op.id).filter(isWaveC);

describe('AI action registry — wave C details (S4)', () => {
  it('has a detail for every wave-C op, and no duplicates', () => {
    const missing = waveCOpIds.filter((id) => !waveCDetailsById.has(id));
    expect(missing, `wave-C ops with no detail:\n${missing.join('\n')}`).toEqual([]);
    expect(waveCDetailsById.size).toBe(waveCDetails.length); // indexById throws on dup; size proves 1:1
    expect(waveCDetails.length).toBe(waveCOpIds.length);
  });

  it('never enriches a non-op or a NEVER route', () => {
    const orphans: string[] = [];
    for (const d of waveCDetails) {
      const op = opsById.get(d.id);
      if (!op) {
        orphans.push(`${d.id} (no such op)`);
        continue;
      }
      if (neverByKey.has(routeKey(op.method, op.path))) orphans.push(`${d.id} (route is NEVER)`);
    }
    expect(orphans, `detail ids that are not live ops:\n${orphans.join('\n')}`).toEqual([]);
  });

  it('well-forms every detail (profile, flags, prose)', () => {
    for (const d of waveCDetails) {
      expect(REDACT_PROFILES, d.id).toContain(d.redact);
      expect(typeof d.notifies, d.id).toBe('boolean');
      expect(d.title.length, d.id).toBeGreaterThan(0);
      expect(d.description.length, d.id).toBeGreaterThan(0);
      expect(typeof d.input.safeParse, d.id).toBe('function');
    }
  });

  it('accepts each example against its own input schema', () => {
    const bad: string[] = [];
    for (const d of waveCDetails) {
      for (const ex of d.examples) {
        const r = d.input.safeParse(ex.args);
        if (!r.success) bad.push(`${d.id}: ${JSON.stringify(ex.args)} -> ${r.error.message}`);
      }
    }
    expect(bad, `examples rejected by their schema:\n${bad.join('\n')}`).toEqual([]);
  });

  it('rejects unknown keys (strict input)', () => {
    const create = waveCDetailsById.get('client_organizations.create');
    expect(create).toBeDefined();
    expect(create!.input.safeParse({ name: 'X', sneaky: 1 }).success).toBe(false);
  });

  it('flags send/publish ops with openWorldHint (notifies)', () => {
    for (const id of [
      'portal.messages.create',
      'portal.announcements.create',
      'invitations.create',
      'members.offboard.create',
    ]) {
      expect(waveCDetailsById.get(id)?.notifies, id).toBe(true);
    }
  });

  it('finalised the personal-access-token routes into NEVER (architecture B3)', () => {
    for (const [method, path] of [
      ['GET', '/v1/organizations/:orgSlug/me/personal-access-tokens/'],
      ['POST', '/v1/organizations/:orgSlug/me/personal-access-tokens/'],
      ['DELETE', '/v1/organizations/:orgSlug/me/personal-access-tokens/:tokenId'],
    ] as const) {
      expect(neverByKey.has(routeKey(method, path)), `${method} ${path}`).toBe(true);
    }
    const patOps = OPS.filter((op) => op.id.startsWith('me.personal_access_tokens'));
    expect(patOps, 'no PAT op may remain in OPS').toEqual([]);
  });
});
