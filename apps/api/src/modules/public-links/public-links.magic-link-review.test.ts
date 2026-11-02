import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { PublicLinkRow } from '../../common/database/schema.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { PublicLinkSecrets } from './public-link-secrets.js';
import { PublicLinkTargets } from './public-link-targets.js';
import type { PublicLinkKind } from './public-link-targets.js';
import { PublicLinksRepository } from './public-links.repository.js';
import { MAGIC_SIGNIN_TTL_MS, PublicLinksService } from './public-links.service.js';
import type { OutsiderMeta, PublicLinkStore } from './public-links.service.js';

/**
 * 56-28 — the 55-14 magic-link review (56 §5.15) over the existing 56-07 service, fake store.
 * R23-a closes the four gaps: forced single use + 15 minutes, atomic count, flat 404 when consumed.
 * Findings and what is still open are in docs/security/threat-model.md.
 */
const ORG = '0190f000-0000-7000-8000-000000000001';
const LINK = '0190f000-0000-7000-8000-000000000002';
const MEMBERSHIP = '0190f000-0000-7000-8000-000000000003';
const USER = '0190f000-0000-7000-8000-000000000004';
const secrets = new PublicLinkSecrets('test-pepper-of-sufficient-length');

function setup(kind: PublicLinkKind = 'magic_signin', options: { counts?: boolean } = {}) {
  const issued = secrets.issueToken();
  const link: PublicLinkRow = {
    ...{ id: LINK, organizationId: ORG, kind, tokenHash: issued.hash },
    ...{ tokenHint: '', targetType: 'client_membership', targetId: MEMBERSHIP, versionHash: null },
    ...{ audienceEmail: 'c@client.co', requireCode: false, language: 'en', maxUses: 1, uses: 0 },
    ...{ expiresAt: new Date(Date.now() + 15 * 60_000), decision: null, decidedAt: null },
    ...{ createdByUserId: null, createdAt: new Date(), revokedAt: null, revokedByUserId: null },
    lastOpenedAt: null,
  };
  const opens: string[] = [];
  const events: string[] = [];
  const audits: { action: string; metadata: Record<string, string> }[] = [];
  const inserted: PublicLinkRow[] = [];
  const contexts: TenantContext[] = [];
  const store = {
    findById: async (_r: unknown, c: TenantContext) => (contexts.push(c), link),
    recordOpen: async (_r: unknown, _c: unknown, _id: string, at: Date) => {
      if (options.counts === false) return false;
      opens.push(at.toISOString());
      Object.assign(link, { uses: link.uses + 1, lastOpenedAt: at });
      return true;
    },
    insert: async (_r: unknown, _c: unknown, row: PublicLinkRow) => void inserted.push(row),
    appendEvent: async (_r: unknown, _c: unknown, e: { kind: string }) => void events.push(e.kind),
    organizationName: async () => 'Northstar',
  } as unknown as PublicLinkStore;
  const targets = new PublicLinkTargets();
  targets.register({
    targetType: 'client_membership',
    kinds: ['magic_signin', 'approval'],
    manageCapability: 'client_member.manage',
    decisions: [],
    resolve: async (_r, c, id) =>
      c.organizationId === ORG && id === MEMBERSHIP
        ? { projectId: null, versionHash: null, projection: { membershipId: MEMBERSHIP } }
        : null,
  });
  const record = async (_r: unknown, _c: unknown, e: { action: string; metadata?: unknown }) =>
    (audits.push(e as (typeof audits)[number]), {}) as never;
  const service = new PublicLinksService({
    database: { transaction: (_c, work) => work({} as never), read: (_c, w) => w({} as never) },
    lookup: async (hash) => (hash === issued.hash ? { id: LINK, organizationId: ORG } : null),
    ...{ targets, secrets, audit: { record }, mailer: null, store },
  });
  return { service, token: issued.token, opens, events, audits, inserted, contexts };
}

const unknownRejection = (s: ReturnType<typeof setup>) =>
  s.service.open('tmanage_lnk_unknown', {}).catch((e: unknown) => e);

describe('55-14 magic-link review', () => {
  it('SEC56-23 a magic_signin link is single use: the second open is refused', async () => {
    const s = setup();
    await expect(s.service.open(s.token, {})).resolves.toMatchObject({ state: 'active' });
    await expect(s.service.open(s.token, {})).rejects.toMatchObject({ status: 404 });
    expect(s.opens).toHaveLength(1);
    await expect(s.service.open('tmanage_lnk_unknown', {})).rejects.toMatchObject({ status: 404 });
  });

  it('SEC56-23b a consumed magic link answers exactly the flat 404 of an unknown token', async () => {
    const s = setup();
    await s.service.open(s.token, {});
    const consumed = (await s.service.open(s.token, {}).catch((e: unknown) => e)) as object;
    const unknown = (await unknownRejection(s)) as Record<string, unknown>;
    expect(consumed).toMatchObject({
      status: unknown['status'],
      code: unknown['code'],
      message: unknown['message'],
      auditCode: unknown['auditCode'],
    });
    expect(consumed).not.toHaveProperty('state');
    await expect(s.service.sendCode(s.token, {})).rejects.toMatchObject({ status: 404 });
  });

  it('SEC56-23c an approval link with maxUses 1 still answers expired on the second open', async () => {
    const s = setup('approval');
    await s.service.open(s.token, {});
    await expect(s.service.open(s.token, {})).resolves.toEqual({ state: 'expired' });
  });

  it('SEC56-23d the kind forces maxUses 1 and a 15-minute expiry, and says so in audit', async () => {
    const s = setup();
    const at = new Date();
    const context = createServiceContext({
      organizationId: ORG,
      correlationId: LINK,
      policyVersion: 't',
    });
    const owner = {
      ...{ userId: USER, organizationId: ORG, kind: 'internal', role: 'owner' },
      ...{ membershipId: MEMBERSHIP, membershipStatus: 'active', clientOrganizationId: null },
      ...{ projectIds: [], hasOrgWideScope: true },
    } as Principal;
    const service = new PublicLinksService({
      ...(s.service as unknown as { options: object }).options,
      now: () => at,
    } as never);
    await service.createInTransaction({} as never, context, owner, {
      ...{ kind: 'magic_signin', targetType: 'client_membership', targetId: MEMBERSHIP },
      ...{ audienceEmail: 'c@client.co', requireCode: false, language: 'en' },
      ...{ expiresInDays: 30, maxUses: null },
    });
    expect(s.inserted[0]).toMatchObject({ maxUses: 1 });
    expect(s.inserted[0]?.expiresAt.getTime()).toBe(at.getTime() + MAGIC_SIGNIN_TTL_MS);
    expect(s.audits[0]?.metadata).toMatchObject({ forced_policy: 'magic_signin' });
  });

  it('SEC56-23e an open the atomic count refused shows nothing and writes no opened row', async () => {
    const magic = setup('magic_signin', { counts: false });
    await expect(magic.service.open(magic.token, {})).rejects.toMatchObject({ status: 404 });
    const approval = setup('approval', { counts: false });
    await expect(approval.service.open(approval.token, {})).resolves.toEqual({ state: 'expired' });
    for (const s of [magic, approval]) {
      expect(s.events).toEqual([]);
      expect(s.audits).toEqual([]);
    }
  });

  it('SEC56-23f recordOpen counts only while uses < max_uses and reports a used-up row', async () => {
    const statements: string[] = [];
    const runner = {
      query: async (sql: string) => (statements.push(sql), { affectedRows: 0 }),
    } as unknown as TenantQueryRunner;
    const context = createServiceContext({
      organizationId: ORG,
      correlationId: LINK,
      policyVersion: 't',
    });
    await expect(
      new PublicLinksRepository().recordOpen(runner, context, LINK, new Date()),
    ).resolves.toBe(false);
    expect(statements[0]).toMatch(
      /`max_uses` is null or `public_links`\.`uses` < `public_links`\.`max_uses`/u,
    );
  });

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
