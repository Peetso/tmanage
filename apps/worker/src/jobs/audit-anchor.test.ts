import { describe, expect, it } from 'vitest';
import {
  anchorMessage,
  anchorSignerFromEnv,
  genesisHash,
  runAuditBackfill,
  runDailyAnchors,
} from './audit-anchor.js';
import type { AnchorRecord, AuditAnchorStore, PlatformAnchorRecord } from './audit-anchor.js';

/** 56-11 — backfill marks the chain start; the daily anchor signs once per day (or unsigned). */

function fakeStore(orgs: string[]) {
  const heads = new Map<string, string>();
  const anchors: AnchorRecord[] = [];
  const platform: PlatformAnchorRecord[] = [];
  const store: AuditAnchorStore = {
    organizationsWithoutHead: async (limit) => orgs.filter((o) => !heads.has(o)).slice(0, limit),
    markChainStart: async (org, genesis) => void heads.set(org, genesis),
    heads: async () =>
      [...heads].map(([organizationId, headHash]) => ({ organizationId, chainSeq: 0, headHash })),
    insertAnchor: async (a) =>
      anchors.some((x) => x.organizationId === a.organizationId && x.day === a.day)
        ? false
        : (anchors.push(a), true),
    anchorsForDay: async (day) => anchors.filter((a) => a.day === day),
    insertPlatformAnchor: async (p) =>
      platform.some((x) => x.day === p.day) ? false : (platform.push(p), true),
  };
  return { store, heads, anchors, platform };
}

describe('audit anchor jobs (56-11)', () => {
  it('backfill marks the chain start at the organization genesis, once', async () => {
    const { store, heads } = fakeStore(['org-1', 'org-2']);
    expect(await runAuditBackfill(store)).toBe(2);
    expect(await runAuditBackfill(store)).toBe(0);
    expect(heads.get('org-1')).toBe(genesisHash('org-1'));
  });

  it('anchors the previous UTC day once, signed with the shared golden vector, unsigned without a key', async () => {
    const signer = anchorSignerFromEnv({
      AUDIT_ANCHOR_KEY: '1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
    });
    expect(
      signer.sign(
        anchorMessage({
          organizationId: 'org-1',
          day: '2026-10-29',
          headHash: 'a'.repeat(64),
          eventCount: 3,
        }),
      ),
    ).toBe('v1:1:3deee75d88aec5182334c0496552d19187b8fed78cdc6bd349ce6cb61276fcf6');

    const { store, anchors, platform } = fakeStore(['org-1']);
    await runAuditBackfill(store);
    const now = new Date('2026-10-30T01:00:00Z');
    const first = await runDailyAnchors({ store, signer, now });
    const again = await runDailyAnchors({ store, signer, now });
    expect([first.day, first.anchored, again.anchored, platform.length]).toEqual([
      '2026-10-29',
      1,
      0,
      1,
    ]);
    expect(anchors[0]?.signature).toMatch(/^v1:1:[0-9a-f]{64}$/u);

    const keyless = fakeStore(['org-1']);
    await runAuditBackfill(keyless.store);
    await runDailyAnchors({ store: keyless.store, signer: anchorSignerFromEnv({}), now });
    expect([keyless.anchors[0]?.signature, keyless.platform[0]?.signature]).toEqual([null, null]);
  });
});
