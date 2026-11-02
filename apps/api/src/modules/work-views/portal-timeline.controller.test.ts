import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PortalTimelineController, PortalTimelineService } from './portal-timeline.controller.js';
import type { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import type { ProjectPhasesRepository } from '../projects/phases.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  MilestoneClientProjectionRow,
  ProjectPhaseRow,
} from '../../common/database/schema.js';

/**
 * 53-07 — the client timeline over fakes with the real `authorize()`: it is built from the
 * published copies only (53-T-17 shape: no owner, internal title, forecast or reason), and a
 * project the client organization does not reach through `project_clients` is a 404.
 */

const ORG = 'org-under-test';
const PROJECT = 'project-shared';
const OTHER_PROJECT = 'project-not-shared';

function client(projectIds: readonly string[]): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-client-1',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org',
    projectIds,
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: 'client-user-1' } as unknown as TenantContext;

function controller(): PortalTimelineController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const copies: MilestoneClientProjectionRow[] = [
    {
      id: 'copy-1',
      organizationId: ORG,
      projectId: PROJECT,
      milestoneId: 'milestone-1',
      clientTitle: 'Website live',
      committedOn: '2026-12-15',
      status: 'on_track',
      phaseName: 'Build',
      publishedByUserId: 'user-staff-secret',
      publishedAt: new Date('2026-11-01T10:00:00.000Z'),
    },
  ];
  const milestones = {
    listProjections: async () => copies,
  } as unknown as ProjectMilestonesRepository;
  const phases = {
    listDefinitions: async () =>
      [
        {
          id: 'phase-1',
          organizationId: ORG,
          projectId: PROJECT,
          name: 'Build',
          position: 0,
          milestoneId: null,
          phaseId: null,
          startsOn: null,
          endsOn: null,
          colorToken: 'accent.teal',
          createdAt: new Date('2026-10-01T00:00:00.000Z'),
        },
      ] as ProjectPhaseRow[],
  } as unknown as ProjectPhasesRepository;
  return new PortalTimelineController(new PortalTimelineService(database, milestones, phases));
}

describe('53-07 portal timeline', () => {
  it('names only the client-safe fields (53-T-17 shape)', async () => {
    const view = await controller().timeline(context, client([PROJECT]), PROJECT);
    expect(view).toEqual({
      phases: [{ name: 'Build', startsOn: '2026-12-15', endsOn: '2026-12-15' }],
      milestones: [{ clientTitle: 'Website live', committedOn: '2026-12-15', status: 'on_track' }],
      publishedAt: '2026-11-01T10:00:00.000Z',
    });
    expect(JSON.stringify(view)).not.toMatch(/user-staff-secret|milestone-1|accent|forecast/);
  });

  it('answers 404 for a project the client organization does not reach', async () => {
    await expect(
      controller().timeline(context, client([PROJECT]), OTHER_PROJECT),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('is guarded by client_projection.read', () => {
    const handler = (PortalTimelineController.prototype as unknown as Record<string, object>)[
      'timeline'
    ] as object;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, handler)).toBe('client_projection.read');
  });
});
