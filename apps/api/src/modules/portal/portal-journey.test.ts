import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ClientProjectionRow, ProjectMilestoneRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { deriveJourney } from './portal-journey.js';
import { PortalJourneyService } from './portal-journey.service.js';
import type { PortalJourneyRepository } from './portal-journey.repository.js';

const milestone = (id: string, status: ProjectMilestoneRow['status']) =>
  ({ id, title: `t-${id}`, clientTitle: null, dueOn: null, status }) as ProjectMilestoneRow;
const version = (deliverableId: string, id: string, at: string, decision: string | null) =>
  ({
    deliverableId,
    deliverableVersionId: id,
    publishedAt: new Date(at),
    projection: { title: id, decision },
  }) as ClientProjectionRow;

describe('52-27 client journey', () => {
  it('marks steps done/now/next and picks the oldest undecided newest version as the turn', () => {
    const journey = deriveJourney(
      'p1',
      [milestone('a', 'met'), milestone('b', 'missed'), milestone('c', 'planned')],
      [
        version('d1', 'd1-v2', '2026-11-12', null),
        version('d2', 'd2-v1', '2026-11-11', null),
        version('d1', 'd1-v1', '2026-11-01', null),
      ],
    );
    expect(journey.steps.map((s) => s.state)).toEqual(['done', 'now', 'next']);
    expect(journey.yourTurn?.deliverableVersionId).toBe('d2-v1');
    expect(journey.completed).toBe(false);
  });

  it("refuses another client's project with 404 before reading", async () => {
    const principal = {
      kind: 'client',
      role: 'client_member',
      organizationId: 'org',
      clientOrganizationId: 'client-a',
      projectIds: ['own-project'],
      hasOrgWideScope: false,
      membershipStatus: 'active',
    } as unknown as Principal;
    const database = {
      read: () => Promise.reject(new Error('read before the relation check')),
    } as unknown as TenantDatabase;
    const service = new PortalJourneyService(database, {} as PortalJourneyRepository);
    await expect(
      service.forProject({ organizationId: 'org' } as TenantContext, principal, 'other-project'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
