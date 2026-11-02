import { describe, expect, it } from 'vitest';
import type { PublicLinkRow } from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { PublicLinkSecrets } from './public-link-secrets.js';
import { PublicLinkTargets } from './public-link-targets.js';
import { PublicLinksService } from './public-links.service.js';
import type { OutsiderMeta, PublicLinkStore } from './public-links.service.js';

/**
 * 56-28 — the 55-14 magic-link review (56 §5.15) over the existing 56-07 service, fake store.
 * Findings and the gaps these tests do NOT close are in docs/security/threat-model.md.
 */
const ORG = '0190f000-0000-7000-8000-000000000001';
const LINK = '0190f000-0000-7000-8000-000000000002';
const MEMBERSHIP = '0190f000-0000-7000-8000-000000000003';
const secrets = new PublicLinkSecrets('test-pepper-of-sufficient-length');

function setup() {
  const issued = secrets.issueToken();
  const link: PublicLinkRow = {
    ...{ id: LINK, organizationId: ORG, kind: 'magic_signin', tokenHash: issued.hash },
    ...{ tokenHint: '', targetType: 'client_membership', targetId: MEMBERSHIP, versionHash: null },
    ...{ audienceEmail: 'c@client.co', requireCode: false, language: 'en', maxUses: 1, uses: 0 },
    ...{ expiresAt: new Date(Date.now() + 15 * 60_000), decision: null, decidedAt: null },
    ...{ createdByUserId: null, createdAt: new Date(), revokedAt: null, revokedByUserId: null },
    lastOpenedAt: null,
  };
  const opens: string[] = [];
  const contexts: TenantContext[] = [];
  const store = {
    findById: async (_r: unknown, c: TenantContext) => (contexts.push(c), link),
    recordOpen: async (_r: unknown, _c: unknown, _id: string, at: Date) => {
      opens.push(at.toISOString());
      Object.assign(link, { uses: link.uses + 1, lastOpenedAt: at });
    },
    appendEvent: async () => undefined,
    organizationName: async () => 'Northstar',
  } as unknown as PublicLinkStore;
  const targets = new PublicLinkTargets();
  targets.register({
    targetType: 'client_membership',
    kinds: ['magic_signin'],
    manageCapability: 'client_member.manage',
    decisions: [],
    resolve: async (_r, c, id) =>
      c.organizationId === ORG && id === MEMBERSHIP
        ? { projectId: null, versionHash: null, projection: { membershipId: MEMBERSHIP } }
        : null,
  });
  const service = new PublicLinksService({
    database: { transaction: (_c, work) => work({} as never), read: (_c, w) => w({} as never) },
    lookup: async (hash) => (hash === issued.hash ? { id: LINK, organizationId: ORG } : null),
    ...{ targets, secrets, audit: { record: async () => ({}) as never }, mailer: null, store },
  });
  return { service, token: issued.token, opens, contexts };
}

describe('55-14 magic-link review', () => {
  it('SEC56-23 a magic_signin link is single use: the second open is refused', async () => {
    const s = setup();
    await expect(s.service.open(s.token, {})).resolves.toMatchObject({ state: 'active' });
    const second = await s.service.open(s.token, {});
    expect(second).toEqual({ state: 'expired' });
    expect(second).not.toHaveProperty('projection');
    expect(s.opens).toHaveLength(1);
    await expect(s.service.open('tmanage_lnk_unknown', {})).rejects.toMatchObject({ status: 404 });
  });

  it.todo('SEC56-23 gap: a consumed magic link answers the flat 404 of an unknown token');

  it('SEC56-24 opening a magic link never reads or merges another session', async () => {
    const s = setup();
    const read: string[] = [];
    const request = { ip: '203.0.113.9', userAgent: 'ua', cookie: 'tm_session=client-b' };
    const meta = new Proxy(request, {
      get: (target, key) => (read.push(String(key)), Reflect.get(target, key)),
    }) as OutsiderMeta;
    const view = await s.service.open(s.token, meta);
    expect(read.every((key) => key === 'ip' || key === 'userAgent')).toBe(true);
    expect(s.service.open.length).toBe(2);
    expect(s.contexts.every((c) => c.principalKind === 'service' && c.organizationId === ORG)).toBe(
      true,
    );
    expect(JSON.stringify(view)).not.toMatch(/session|userId|client-b/u);
  });
});
