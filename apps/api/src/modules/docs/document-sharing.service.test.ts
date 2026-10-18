import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { DocumentSharingService } from './document-sharing.service.js';
import type { DocumentsRepository } from './documents.repository.js';
import type { DocumentSharingRepository } from './document-sharing.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { DocumentRow } from '../../common/database/schema.js';

/** Docs sharing proofs over fakes and the real `authorize()`: relation filter, publish gate, names. */

const ORG = 'org-1';
const MINE = 'project-mine';
const OTHER = 'project-other';
const context = { organizationId: ORG, userId: 'u-1', membershipId: 'm-1' } as TenantContext;

function principal(role: 'member' | 'manager', projectIds: readonly string[]): Principal {
  return {
    userId: 'u-1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

const doc = {
  id: 'd-1',
  organizationId: ORG,
  projectId: MINE,
  createdByUserId: 'u-2',
} as DocumentRow;

function build(audienceError?: Error) {
  const writes: string[] = [];
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const documents = {
    findById: async (_r: unknown, _c: unknown, id: string) => (id === doc.id ? doc : null),
  } as unknown as DocumentsRepository;
  const sharing = {
    recent: async () => [
      {
        id: 'd-1',
        organizationId: ORG,
        projectId: MINE,
        projectName: 'Atlas',
        title: 'Brief',
        updatedAt: new Date(),
      },
      {
        id: 'd-2',
        organizationId: ORG,
        projectId: OTHER,
        projectName: 'Secret',
        title: 'Hidden',
        updatedAt: new Date(),
      },
    ],
    audiences: async () => {
      if (audienceError) throw audienceError;
      return [{ id: 'd-1', audience: 'client', publishedAt: new Date() }];
    },
    clientCounts: async () => new Map([[MINE, 2]]),
    setAudience: async (_r: unknown, _c: unknown, _id: string, audience: string) => {
      writes.push(audience);
    },
    contributors: async () => ({ editorUserIds: ['u-3', 'u-2'], commenterMembershipIds: ['m-3'] }),
    people: async () => [
      { membershipId: 'm-2', userId: 'u-2', displayName: 'Maya Hassan' },
      { membershipId: 'm-3', userId: 'u-3', displayName: 'Omar Adel' },
    ],
  } as unknown as DocumentSharingRepository;
  return { service: new DocumentSharingService(database, documents, sharing), writes };
}

describe('DocumentSharingService', () => {
  it('lists recent documents the caller can read and only counts the rest', async () => {
    const view = await build().service.recent(context, principal('member', [MINE]));
    expect(view.documents.map((d) => d.title)).toEqual(['Brief']);
    expect(view.documents[0]).toMatchObject({ audience: 'client', clientAudienceCount: 2 });
    expect(view.hiddenCount).toBe(1);
    expect(JSON.stringify(view)).not.toContain('Hidden');
  });

  it('treats every document as internal until the audience migration has run', async () => {
    const missing = Object.assign(new Error('Unknown column'), { errno: 1054 });
    const view = await build(missing).service.recent(context, principal('member', [MINE]));
    expect(view.documents[0]?.audience).toBe('internal');
  });

  it('lets a project manager publish, refuses a member (403) and hides it from a non-member (404)', async () => {
    const manager = build();
    await manager.service.setAudience(context, principal('manager', [MINE]), 'd-1', 'client');
    expect(manager.writes).toEqual(['client']);

    const member = build();
    const denied = await member.service
      .setAudience(context, principal('member', [MINE]), 'd-1', 'client')
      .catch((e: unknown) => e);
    expect((denied as ApiError).status).toBe(403);

    const hidden = await member.service
      .setAudience(context, principal('manager', [OTHER]), 'd-1', 'client')
      .catch((e: unknown) => e);
    expect((hidden as ApiError).status).toBe(404);
    expect(member.writes).toEqual([]);
  });

  it('names collaborators creator first, each once, and says whether the caller may publish', async () => {
    const view = await build().service.get(context, principal('member', [MINE]), 'd-1');
    expect(view.collaborators.map((p) => p.displayName)).toEqual(['Maya Hassan', 'Omar Adel']);
    expect(view.canPublish).toBe(false);
  });
});
