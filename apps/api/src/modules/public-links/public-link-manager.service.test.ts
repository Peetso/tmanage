import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { PublicLinkRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ManagedLinkFilter, ManagedLinkRow } from './public-link-manager.repository.js';
import { PublicLinkManagerService } from './public-link-manager.service.js';
import type { PublicLinkManagerStore } from './public-link-manager.service.js';
import { PublicLinkSecrets } from './public-link-secrets.js';
import { PublicLinkTargets } from './public-link-targets.js';
import { PublicLinksService } from './public-links.service.js';
import type { PublicLinkStore } from './public-links.service.js';

const ORG = '0190f000-0000-7000-8000-0000000000a1';
const USER = '0190f000-0000-7000-8000-0000000000c1';
const LINK = '0190f000-0000-7000-8000-0000000000d1';
const SIGNIN = '0190f000-0000-7000-8000-0000000000d2';
const TARGET = '0190f000-0000-7000-8000-0000000000e1';
const NOW = new Date('2026-11-16T10:00:00.000Z');
const context = { organizationId: ORG, userId: USER, correlationId: USER } as TenantContext;
const secrets = new PublicLinkSecrets('test-pepper-of-sufficient-length');

function principal(role: string): Principal {
  return {
    ...{ userId: USER, organizationId: ORG, kind: 'internal', role },
    ...{ membershipId: USER, membershipStatus: 'active', clientOrganizationId: null },
    ...{ projectIds: [], hasOrgWideScope: true },
  } as Principal;
}

function linkRow(id: string, kind: string, tokenHash: string): PublicLinkRow {
  return {
    ...{ id, organizationId: ORG, kind, tokenHash, tokenHint: '' },
    ...{ targetType: 'deliverable_version', targetId: TARGET, versionHash: 'h1' },
    ...{ audienceEmail: null, requireCode: false, language: 'en', maxUses: null, uses: 0 },
    ...{ expiresAt: new Date(Date.now() + 86_400_000), decision: null, decidedAt: null },
    ...{ createdByUserId: USER, createdAt: NOW, revokedAt: null, revokedByUserId: null },
    lastOpenedAt: null,
  } as PublicLinkRow;
}

const managedRow: ManagedLinkRow = {
  ...{ id: LINK, kind: 'approval', targetType: 'deliverable_version', projectId: TARGET },
  ...{ deliverableId: TARGET, deliverableTitle: 'Logo', versionNo: 3, quoteId: null },
  ...{ quoteTitle: null, quoteNumber: null, audienceEmail: 'a@b.co', createdByUserId: USER },
  ...{ createdByName: 'Ana', createdAt: NOW, expiresAt: new Date('2026-11-30T00:00:00Z') },
  ...{ lastOpenedAt: null, uses: 2, maxUses: null, decision: null, revokedAt: null },
  revokedByName: null,
};

function setup() {
  const issued = secrets.issueToken();
  const rows = new Map<string, PublicLinkRow>([
    [LINK, linkRow(LINK, 'approval', issued.hash)],
    [SIGNIN, linkRow(SIGNIN, 'magic_signin', 'other-hash')],
  ]);
  const linkStore = {
    findById: async (_r: unknown, c: TenantContext, id: string) =>
      c.organizationId === ORG ? (rows.get(id) ?? null) : null,
    revoke: async (_r: unknown, _c: unknown, id: string, at: Date) => {
      const row = rows.get(id);
      if (row === undefined || row.revokedAt !== null) return false;
      rows.set(id, { ...row, revokedAt: at, revokedByUserId: USER });
      return true;
    },
    recordOpen: async () => true,
    appendEvent: async () => undefined,
    organizationName: async () => 'Northstar',
  } as unknown as PublicLinkStore;
  const targets = new PublicLinkTargets();
  targets.register({
    targetType: 'deliverable_version',
    kinds: ['approval'],
    manageCapability: 'deliverable.publish',
    decisions: ['approve', 'request_changes'],
    resolve: async () => ({ projectId: null, versionHash: 'h1', projection: { title: 'Logo' } }),
  });
  const database = {
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>) => work({} as never),
    read: <T>(_c: TenantContext, work: (tx: never) => Promise<T>) => work({} as never),
  };
  const audits: string[] = [];
  const audit = {
    record: async (_r: unknown, _c: unknown, e: { action: string }) =>
      (audits.push(e.action), {}) as never,
  };
  const links = new PublicLinksService({
    database,
    lookup: async (hash) => (hash === issued.hash ? { id: LINK, organizationId: ORG } : null),
    targets,
    secrets,
    audit,
    mailer: { send: async () => ({}) as never },
    store: linkStore,
  });
  const seen: { context: TenantContext; filter: ManagedLinkFilter }[] = [];
  const store: PublicLinkManagerStore = {
    page: async (_r, c, filter) => (
      seen.push({ context: c, filter }),
      { rows: [managedRow], total: 1 }
    ),
    counts: async () => ({ active: 1, endingSoon: 0, ended: 0 }),
    creators: async () => [{ id: USER, name: 'Ana' }],
    setExpiry: async (_r, _c, id, kinds) => kinds.includes(rows.get(id)?.kind ?? ''),
  };
  const manager = new PublicLinkManagerService({
    database,
    targets,
    links,
    audit,
    store,
    now: () => NOW,
  });
  return { manager, links, token: issued.token, seen, audits };
}

describe('56-07p public link manager', () => {
  it('lists only the caller organization, only issued kinds, and never a token', async () => {
    const s = setup();
    const view = await s.manager.list(context, principal('owner'), {});
    expect(s.seen[0]?.context.organizationId).toBe(ORG);
    expect(s.seen[0]?.filter.kinds).toEqual(['approval']);
    expect(view.kinds).not.toContain('magic_signin');
    expect(view.links[0]).toMatchObject({ id: LINK, title: 'Logo', reference: '3', openCount: 2 });
    expect(JSON.stringify(view)).not.toMatch(/token|hash/i);
  });

  it('refuses everyone without org.security.manage before reading anything', async () => {
    for (const role of ['member', 'workspace_admin', 'guest']) {
      const s = setup();
      await expect(s.manager.list(context, principal(role), {})).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        s.manager.revokeMany(context, principal(role), { linkIds: [LINK] }),
      ).rejects.toMatchObject({ status: 403 });
      expect(s.seen).toHaveLength(0);
    }
    await expect(setup().manager.list(context, principal('org_admin'), {})).resolves.toBeDefined();
  });

  it('revoke goes through the one revoke path: the link answers revoked at once', async () => {
    const s = setup();
    await expect(s.links.open(s.token, {})).resolves.toMatchObject({ state: 'active' });
    await expect(
      s.manager.revokeMany(context, principal('owner'), { linkIds: [LINK, SIGNIN] }),
    ).resolves.toEqual({ changed: 1, skipped: 1 });
    expect(s.audits).toContain('public_link.revoked');
    await expect(s.links.open(s.token, {})).resolves.toMatchObject({ state: 'revoked' });
  });

  it('moves the end of an issued link with an audit row, and refuses an end past 31 days', async () => {
    const s = setup();
    const expiresAt = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
    await expect(
      s.manager.changeExpiry(context, principal('owner'), { linkIds: [LINK, SIGNIN], expiresAt }),
    ).resolves.toEqual({ changed: 1, skipped: 1 });
    expect(s.audits).toEqual(['public_link.expiry_changed']);
    const tooFar = new Date(NOW.getTime() + 40 * 86_400_000).toISOString();
    await expect(
      s.manager.changeExpiry(context, principal('owner'), { linkIds: [LINK], expiresAt: tooFar }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
