import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, parseFieldCipherKeys } from '@tmanage/domain/field-cipher';
import { GithubHooksService } from './github-hooks.service.js';
import { captureGithubRawBody } from './github-hooks.controller.js';
import type { GithubHooksRepository } from './github-hooks.repository.js';
import type { WorkKeysRepository } from '../work/work-keys.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/** R16-e — HMAC, replay, hour budget, project scoping, secret never projected or audited. */
const HOOK = '0192f000-0000-7000-8000-000000000001';
const ORG = '0192f000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-11-02T12:00:00.000Z');
const cipher = createFieldCipher(parseFieldCipherKeys(`1:${'A'.repeat(43)}=`));
const run = (_c: unknown, work: (r: never) => unknown) => work({} as never);
const db = { read: run, transaction: run, bootstrapRead: run } as unknown as TenantDatabase;
const push = (msg: string) =>
  Buffer.from(
    JSON.stringify({
      ref: 'refs/heads/main',
      repository: { full_name: 'Acme/App', html_url: 'https://github.com/acme/app' },
      commits: [{ id: 'abc', url: 'https://github.com/acme/app/commit/abc', message: msg }],
    }),
  );

function harness(hour = { at: null as Date | null, count: 0 }, projectIdsJson = '["p-1"]') {
  const seen = new Set<string>();
  const links: unknown[] = [];
  const audits: unknown[] = [];
  const hook = {
    id: HOOK,
    organizationId: ORG,
    connectionId: 'c-1',
    repoFullName: 'acme/app',
    status: 'active',
    secretEnc: cipher.encrypt('s3cret', { purpose: 'integration_token', ownerId: HOOK }),
    projectIdsJson,
    eventsHourStartedAt: hour.at,
    eventsHourCount: hour.count,
    lastEventAt: null,
    createdAt: NOW,
  };
  const hooks = {
    findHookOrganization: () => Promise.resolve({ organizationId: ORG, id: HOOK }),
    findById: () => Promise.resolve(hook),
    list: () => Promise.resolve([hook]),
    findByRepo: () => Promise.resolve(null),
    findConnection: () => Promise.resolve({ id: 'c-1' }),
    insert: (_r: never, _c: never, i: { id: string }) => Promise.resolve({ ...hook, id: i.id }),
    deliverySeen: (_r: never, _c: never, _h: string, d: string) => Promise.resolve(seen.has(d)),
    recordDelivery: (_r: never, _c: never, _h: string, d: string) =>
      Promise.resolve(void seen.add(d)),
    recordEvent: () => Promise.resolve(),
  } as unknown as GithubHooksRepository;
  const keys = {
    findProject: () => Promise.resolve({ id: 'p-1', archivedAt: null }),
    activePrefixes: (_r: never, _c: never, ids: string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, 'TM']))),
    resolveKeys: (_r: never, _c: never, k: string[], projects: string[]) =>
      Promise.resolve(
        new Map(k.filter(() => projects.includes('p-1')).map((key) => [key, `wi-${key}`])),
      ),
    upsertLink: (_r: never, _c: never, link: unknown) => Promise.resolve(void links.push(link)),
  } as unknown as WorkKeysRepository;
  const audit = {
    append: (_r: never, _c: never, input: unknown) => (audits.push(input), Promise.resolve({})),
  };
  const service = new GithubHooksService(db, hooks, {
    cipher,
    keys,
    audit: audit as never,
    now: () => NOW,
  });
  const sign = (body: Buffer, secret: string) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const send = (body: Buffer, signature: string | null = sign(body, 's3cret')) =>
    service.receive({
      hookId: HOOK,
      rawBody: body,
      deliveryId: 'd-1',
      event: 'push',
      correlationId: HOOK,
      signature: signature ?? undefined,
    });
  return { service, send, links, audits };
}

describe('GitHub repository webhooks (R16-e)', () => {
  it('answers 401 to a bad or missing signature and writes nothing', async () => {
    const h = harness();
    expect(await h.send(push('TM-1'), `sha256=${'0'.repeat(64)}`)).toBe(401);
    expect(await h.send(push('TM-1'), null)).toBe(401);
    expect(h.links).toHaveLength(0);
  });

  it('links a key once and answers a replayed delivery 202 with no new write', async () => {
    const h = harness();
    expect(await h.send(push('Fix TM-7 hero'))).toBe(202);
    expect(await h.send(push('Fix TM-7 hero'))).toBe(202);
    expect(h.links).toEqual([
      expect.objectContaining({
        workItemId: 'wi-TM-7',
        linkKind: 'commit',
        title: 'Fix TM-7 hero',
      }),
    ]);
  });

  it('refuses the 601st event of the hour with 429', async () => {
    expect(
      await harness({ at: new Date(NOW.getTime() - 60_000), count: 600 }).send(push('TM-1')),
    ).toBe(429);
    expect(
      await harness({ at: new Date(NOW.getTime() - 3_700_000), count: 600 }).send(push('TM-1')),
    ).toBe(202);
  });

  it('ignores a key of an item outside the hook’s projects', async () => {
    const h = harness(undefined, '["p-2"]');
    expect(await h.send(push('TM-1'))).toBe(202);
    expect(h.links).toHaveLength(0);
  });

  it('never puts the secret in the projection or the audit row', async () => {
    const h = harness();
    const view = await h.service.create(
      { organizationId: ORG, userId: 'u-1' } as unknown as TenantContext,
      {
        userId: 'u-1',
        kind: 'internal',
        role: 'owner',
        organizationId: ORG,
        membershipId: 'm-1',
        membershipStatus: 'active',
        projectIds: ['p-1'],
        hasOrgWideScope: true,
        clientOrganizationId: null,
      },
      { repoFullName: 'acme/app', projectIds: ['p-1'] },
    );
    expect(view.secret).toHaveLength(43);
    const { secret, ...rest } = view;
    expect(JSON.stringify([rest, h.audits, await h.service.list({} as never)])).not.toContain(
      secret,
    );
  });

  it('keeps the raw bytes of the inbound route only', async () => {
    const request: { url: string; rawBody?: Buffer } = {
      url: `/v1/public/integrations/github/${HOOK}`,
    };
    await captureGithubRawBody(request, null, Readable.from([Buffer.from('{"a": 1}')]));
    const other: { url: string; rawBody?: Buffer } = { url: '/v1/public/forms/x/submissions' };
    await captureGithubRawBody(other, null, Readable.from([Buffer.from('{}')]));
    expect([request.rawBody?.toString(), other.rawBody]).toEqual(['{"a": 1}', undefined]);
  });
});
