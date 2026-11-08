import type { Principal } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DocumentCollabService } from './document-collab.service.js';

const context = {
  organizationId: 'org-1',
  userId: 'user-1',
  membershipId: 'm-1',
} as unknown as TenantContext;

function principal(role: string, projectIds: readonly string[]): Principal {
  return {
    userId: 'user-1',
    organizationId: 'org-1',
    kind: role.startsWith('client') ? 'client' : 'internal',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  } as unknown as Principal;
}

function service(enabled = true) {
  const saved: string[] = [];
  const db = { read: (_c: unknown, w: (r: unknown) => unknown) => w({}) } as TenantDatabase;
  const documents = {
    get: async () => ({ projectId: 'p-1' }) as never,
    saveVersion: async (_c: unknown, _p: unknown, _d: unknown, html: string) => {
      saved.push(html);
      return {} as never;
    },
  };
  const people = { people: async () => [{ displayName: 'Sara' }] as never };
  return { svc: new DocumentCollabService(db, documents, people, enabled), saved };
}

const step = { stepType: 'replace', from: 1, to: 1 };

describe('DocumentCollabService (53-10)', () => {
  it('is 404 everywhere while the switch is off', async () => {
    const { svc } = service(false);
    await expect(svc.join(context, principal('member', ['p-1']), 'd')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('a project member joins as editor, pushes, snapshots and shows a cursor', async () => {
    const { svc, saved } = service();
    const me = principal('member', ['p-1']);
    expect(await svc.join(context, me, 'd')).toMatchObject({ role: 'editor', version: 0 });
    expect(await svc.push(context, me, 'd', { version: 0, clientId: 'c', steps: [step] })).toEqual({
      accepted: true,
      version: 1,
    });
    expect(
      await svc.snapshot(context, me, 'd', { version: 1, html: '<p>a</p>', orgSlug: 's' }),
    ).toEqual({ saved: true, version: 1 });
    expect(saved).toEqual(['<p>a</p>']);
    await svc.cursor(context, me, 'd', { clientId: 'c', anchor: 2, head: 2 });
    expect((await svc.poll(context, me, 'd', 1)).cursors).toMatchObject([{ name: 'Sara' }]);
  });

  it('refuses a stale snapshot without saving', async () => {
    const { svc, saved } = service();
    const me = principal('member', ['p-1']);
    await svc.push(context, me, 'd', { version: 0, clientId: 'c', steps: [step] });
    expect(
      await svc.snapshot(context, me, 'd', { version: 0, html: '<p>a</p>', orgSlug: 's' }),
    ).toEqual({ saved: false, version: 1 });
    expect(saved).toEqual([]);
  });

  it('a reader without write rights joins read-only and every write is 403', async () => {
    const { svc } = service();
    const viewer = principal('client_viewer', ['p-1']);
    expect(await svc.join(context, viewer, 'd')).toMatchObject({ role: 'viewer' });
    await expect(
      svc.push(context, viewer, 'd', { version: 0, clientId: 'c', steps: [step] }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      svc.cursor(context, viewer, 'd', { clientId: 'c', anchor: 1, head: 1 }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
