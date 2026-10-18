import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { InsightsAdoptionController, rollUpAdoption } from './adoption.controller.js';
import type { AdoptionReads } from './adoption.controller.js';
import { InsightsAdoptionRepository } from './adoption.repository.js';
import type {
  AdoptionMeetingRow,
  AdoptionMemberRow,
  AdoptionWorkOwnerRow,
} from './adoption.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * INS-06 — the org-wide adoption roll-up. Database-free proofs over the module's fakes with the
 * **real** `authorize`: the three reads are ordinary tenant-scoped `SELECT`s (no schema change, so
 * no `.db.test.ts`), and the properties the controller owns are unit-provable:
 *   - the aggregation is correct and tenant-scoped — distinct members/owners, meeting count, and a
 *     cross-tenant row that reaches the loop is dropped before it contributes (Known-trap);
 *   - an over-wide window is a 400, never a silent clamp into an unbounded scan;
 *   - a principal `work.read` refuses (a client — the capability is internal-only) is a 403, the
 *     org-level relation half of the route's `work.read` ceiling.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

function orgWide(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'org_admin',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000003',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-0000-0000-000000000003',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    projectIds: [],
    hasOrgWideScope: false,
  };
}

function controllerWith(
  members: readonly AdoptionMemberRow[],
  owners: readonly AdoptionWorkOwnerRow[],
  meetings: readonly AdoptionMeetingRow[],
): InsightsAdoptionController {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const none = async () => [];
  const repository = {
    listActiveMembers: async () => members,
    listRecentWorkOwners: async () => owners,
    listMeetingsHeld: async () => meetings,
    listDatedWork: none,
    listChannels: none,
    listChannelsWithWork: none,
    listApprovalHashes: none,
    listVersionHashes: none,
    listDecisionsLogged: none,
    listApprovalsDecided: none,
    listUntriagedChatWork: none,
    listClientFilesMarkedInternal: none,
    listRequestsAwaitingCommitment: none,
    listProjectNames: none,
  } as unknown as InsightsAdoptionRepository;

  return new InsightsAdoptionController(database, repository);
}

const EMPTY_READS: AdoptionReads = {
  members: [],
  owners: [],
  meetings: [],
  datedWork: [],
  channels: [],
  channelsWithWork: [],
  approvalHashes: [],
  versionHashes: [],
  decisionsLogged: [],
  approvalsDecided: [],
  gaps: { chat_work_untriaged: [], client_files_internal: [], requests_uncommitted: [] },
  projectNames: [],
};

describe('InsightsAdoptionController wiring', () => {
  it('declares an explicit injection token for the repository (no decorator metadata — the live 500)', () => {
    const declared = (Reflect.getMetadata('self:paramtypes', InsightsAdoptionController) ?? []) as {
      index: number;
      param: unknown;
    }[];
    expect(declared.find((entry) => entry.index === 1)?.param).toBe(InsightsAdoptionRepository);
  });
});

describe('rollUpAdoption', () => {
  it('computes the system-quality metrics from the reads and drops every cross-tenant row', () => {
    const view = rollUpAdoption(
      ORG,
      14,
      {
        ...EMPTY_READS,
        datedWork: [
          { organizationId: ORG, inWindow: true, dated: true },
          { organizationId: ORG, inWindow: true, dated: false },
          { organizationId: ORG, inWindow: false, dated: true },
          { organizationId: OTHER_ORG, inWindow: true, dated: false },
        ],
        channels: [
          { organizationId: ORG, conversationId: 'c1' },
          { organizationId: ORG, conversationId: 'c2' },
          { organizationId: OTHER_ORG, conversationId: 'c9' },
        ],
        channelsWithWork: [{ organizationId: ORG, conversationId: 'c1' }],
        approvalHashes: [
          {
            organizationId: ORG,
            deliverableId: 'd1',
            deliverableVersionId: 'v1',
            contentHash: 'a',
            inWindow: true,
          },
          {
            organizationId: ORG,
            deliverableId: 'd2',
            deliverableVersionId: 'v2',
            contentHash: 'x',
            inWindow: true,
          },
          {
            organizationId: ORG,
            deliverableId: 'd3',
            deliverableVersionId: 'v3',
            contentHash: 'c',
            inWindow: false,
          },
        ],
        versionHashes: [
          { organizationId: ORG, versionId: 'v1', contentHash: 'a' },
          { organizationId: ORG, versionId: 'v2', contentHash: 'b' },
          { organizationId: OTHER_ORG, versionId: 'v3', contentHash: 'c' },
        ],
        decisionsLogged: [{ organizationId: ORG, projectId: 'p1' }],
        approvalsDecided: [{ organizationId: OTHER_ORG, projectId: 'p1' }],
        gaps: {
          chat_work_untriaged: [
            { organizationId: ORG, projectId: 'p1' },
            { organizationId: ORG, projectId: 'p2' },
          ],
          client_files_internal: [],
          requests_uncommitted: [
            { organizationId: ORG, projectId: 'p1' },
            { organizationId: OTHER_ORG, projectId: 'p2' },
          ],
        },
        projectNames: [{ organizationId: ORG, projectId: 'p1', name: 'Atlas Relaunch' }],
      },
      new Date('2026-10-18T00:00:00.000Z'),
    );

    expect(view.committedDate).toEqual({ dated: 1, total: 2, previousDated: 1, previousTotal: 1 });
    expect(view.channels).toEqual({ total: 2, withoutWork: 1 });
    // d2's hash differs from its version; d3's version is foreign, so it has no stored hash here.
    expect(view.unhashedDeliverables).toEqual({ current: 1, previous: 1 });
    expect(view.decisionsRecorded).toEqual({ decisionLog: 1, approvals: 0 });
    expect(view.gaps).toEqual([
      { id: 'chat_work_untriaged', count: 2, projectCount: 2, projectName: null },
      { id: 'client_files_internal', count: 0, projectCount: 0, projectName: null },
      { id: 'requests_uncommitted', count: 1, projectCount: 1, projectName: 'Atlas Relaunch' },
    ]);
  });
});

describe('InsightsAdoptionController.adoptionMetrics', () => {
  it('counts distinct active members and work owners and meetings held, dropping a cross-tenant row (Known-trap)', async () => {
    const members: AdoptionMemberRow[] = [
      { organizationId: ORG, userId: 'u1' },
      { organizationId: ORG, userId: 'u2' },
      { organizationId: ORG, userId: 'u1' }, // duplicate user — counted once
      { organizationId: OTHER_ORG, userId: 'u9' }, // cross-tenant — never contributes
    ];
    const owners: AdoptionWorkOwnerRow[] = [
      { organizationId: ORG, ownerUserId: 'u1' },
      { organizationId: ORG, ownerUserId: 'u1' }, // same owner, several items — one adopter
      { organizationId: ORG, ownerUserId: 'u2' },
      { organizationId: OTHER_ORG, ownerUserId: 'u5' }, // cross-tenant — dropped
    ];
    const meetings: AdoptionMeetingRow[] = [
      { organizationId: ORG, meetingId: 'm1' },
      { organizationId: ORG, meetingId: 'm2' },
      { organizationId: ORG, meetingId: 'm3' },
      { organizationId: OTHER_ORG, meetingId: 'm9' }, // cross-tenant — dropped
    ];

    const view = await controllerWith(members, owners, meetings).adoptionMetrics(
      context,
      orgWide(),
    );

    expect(view).toMatchObject({
      windowDays: 30,
      activeMembers: 2,
      membersWithWork: 2,
      meetingsHeld: 3,
    });
    expect(typeof view.computedAt).toBe('string');
  });

  it('refuses an over-wide window with a 400 rather than clamping it', async () => {
    await expect(
      controllerWith([], [], []).adoptionMetrics(context, orgWide(), '91'),
    ).rejects.toMatchObject({ status: 400 });

    // A non-integer is rejected the same way; the default (omitted) is 30, proven above.
    await expect(
      controllerWith([], [], []).adoptionMetrics(context, orgWide(), 'lots'),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('refuses a principal without work.read (a client — the capability is internal-only) with a 403', async () => {
    await expect(
      controllerWith(
        [{ organizationId: ORG, userId: 'u1' }],
        [{ organizationId: ORG, ownerUserId: 'u1' }],
        [{ organizationId: ORG, meetingId: 'm1' }],
      ).adoptionMetrics(context, client()),
    ).rejects.toMatchObject({ status: 403 });
  });
});
