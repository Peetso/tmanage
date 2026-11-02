import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { PublicLinkCodeRow, PublicLinkRow } from '../../common/database/schema.js';
import { createServiceContext } from '../../common/database/tenant-context.js';
import { PublicLinkSecrets } from './public-link-secrets.js';
import { PublicLinkTargets } from './public-link-targets.js';
import { PublicLinksService } from './public-links.service.js';
import type { PublicLinkStore } from './public-links.service.js';

const ORG = '0190f000-0000-7000-8000-000000000001';
const LINK = '0190f000-0000-7000-8000-000000000002';
const TARGET = '0190f000-0000-7000-8000-000000000003';
const secrets = new PublicLinkSecrets('test-pepper-of-sufficient-length');

function setup(overrides: Partial<PublicLinkRow> = {}) {
  const issued = secrets.issueToken();
  const link: PublicLinkRow = {
    ...{ id: LINK, organizationId: ORG, kind: 'approval', tokenHash: issued.hash, tokenHint: '' },
    ...{ targetType: 'deliverable_version', targetId: TARGET, versionHash: 'h1' },
    ...{ audienceEmail: 'a@b.co', requireCode: true, language: 'en', maxUses: null, uses: 0 },
    ...{ expiresAt: new Date(Date.now() + 60_000), decision: null, decidedAt: null },
    ...{ createdByUserId: null, createdAt: new Date(), revokedAt: null, revokedByUserId: null },
    lastOpenedAt: null,
    ...overrides,
  };
  let code: PublicLinkCodeRow | null = null;
  const events: string[] = [];
  const store = {
    findById: async () => link,
    recordOpen: async () => true,
    appendEvent: async (_r: unknown, _c: unknown, e: { kind: string }) => void events.push(e.kind),
    organizationName: async () => 'Northstar',
    countEventsSince: async () => 0,
    putCode: async (
      _r: unknown,
      _c: unknown,
      c: Omit<PublicLinkCodeRow, 'organizationId' | 'attempts'>,
    ) => void (code = { ...c, organizationId: ORG, attempts: 0 }),
    findCode: async () => code,
    countCodeAttempt: async () => void (code && (code = { ...code, attempts: code.attempts + 1 })),
    deleteCode: async () => void (code = null),
    decide: async (_r: unknown, _c: unknown, _id: string, d: string) =>
      link.decision === null ? Boolean(Object.assign(link, { decision: d })) : false,
  } as unknown as PublicLinkStore;
  const targets = new PublicLinkTargets();
  let currentHash = 'h1';
  targets.register({
    targetType: 'deliverable_version',
    kinds: ['approval'],
    manageCapability: 'deliverable.publish',
    decisions: ['approve', 'request_changes'],
    resolve: async (_r, context, id) =>
      context.organizationId === ORG && id === TARGET
        ? { projectId: null, versionHash: currentHash, projection: { title: 'Logo' } }
        : null,
  });
  const mail: string[] = [];
  const service = new PublicLinksService({
    database: { transaction: (c, work) => work({} as never), read: (c, work) => work({} as never) },
    lookup: async (hash) => (hash === issued.hash ? { id: LINK, organizationId: ORG } : null),
    targets,
    secrets,
    audit: { record: async () => ({}) as never },
    mailer: { send: async (m) => (mail.push(m.text), {}) as never },
    store,
  });
  return { service, token: issued.token, link, events, mail, stale: () => (currentHash = 'h2') };
}

const decide = (s: ReturnType<typeof setup>, body: object) =>
  s.service.decide(s.token, { decision: 'approve', versionHash: 'h1', ...body }, {});

describe('56-07 public links', () => {
  it('stores only a peppered hash; a malformed or unknown token is the same 404', async () => {
    const issued = secrets.issueToken();
    expect(issued.token).toMatch(/^tmanage_lnk_[A-Za-z0-9_-]{43}$/);
    expect(issued.hash).toBe(secrets.hashPresented(issued.token));
    expect(issued.hash).not.toContain(issued.token.slice(12));
    const s = setup();
    for (const bad of ['nope', `${s.token.slice(0, -1)}x`, 42]) {
      await expect(s.service.open(bad, {})).rejects.toMatchObject({ status: 404 });
    }
  });

  it('opens an active link in its own organization and records the open', async () => {
    const s = setup();
    await expect(s.service.open(s.token, {})).resolves.toMatchObject({
      state: 'active',
      organizationName: 'Northstar',
      versionHash: 'h1',
    });
    expect(s.events).toEqual(['opened']);
  });

  it('refuses a decision bound to a superseded version', async () => {
    const s = setup({ requireCode: false });
    s.stale();
    await expect(decide(s, {})).rejects.toMatchObject({ status: 409 });
  });

  it('needs the mailed code, counts a wrong one, and takes one terminal decision only', async () => {
    const s = setup();
    await s.service.sendCode(s.token, {});
    const code = /is (\d{6})\./.exec(s.mail[0] ?? '')?.[1] ?? '';
    const wrong = code === '000000' ? '111111' : '000000';
    await expect(decide(s, { code: wrong })).rejects.toMatchObject({ status: 400 });
    expect(s.events).toContain('refused');
    await expect(decide(s, { code })).resolves.toMatchObject({ decision: 'approve' });
    await expect(decide(s, { code })).rejects.toMatchObject({ status: 409 });
  });

  it('cannot issue a link for an object outside the member organization', async () => {
    const s = setup();
    const other = createServiceContext({
      organizationId: TARGET,
      correlationId: LINK,
      policyVersion: 't',
    });
    const body = { kind: 'approval', targetType: 'deliverable_version', targetId: TARGET };
    await expect(s.service.create(other, {} as Principal, body)).rejects.toMatchObject({
      status: 404,
    });
  });
});
