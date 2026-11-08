import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../../common/database/tenant-context.js';
import type { IncidentRecord } from './incidents.repository.js';
import { WorkspaceIncidentsService, toWorkspaceIncidents } from './workspace-incidents.service.js';

const ORG = '0199aa00-0000-7000-8000-0000000000aa';
const OTHER = '0199aa00-0000-7000-8000-0000000000bb';
const AT = new Date('2026-11-07T09:12:00.000Z');

const record = (id: string, over: Partial<IncidentRecord>): IncidentRecord =>
  ({
    id,
    component: 'Files',
    status: 'investigating',
    title: 't',
    body: 'b',
    startedAt: AT,
    resolvedAt: null,
    severity: 'SEV1',
    affectedOrgIds: [],
    countries: ['EG'],
    dataCategories: ['email'],
    personalData: true,
    notifiedCustomersAt: null,
    published: false,
    ...over,
  }) as IncidentRecord;

describe('A17 workspace incidents', () => {
  it('shows published or announced-to-this-workspace incidents, public fields only', () => {
    const views = toWorkspaceIncidents(
      [
        record('pub', { published: true, affectedOrgIds: [OTHER] }),
        record('mine', { affectedOrgIds: [ORG, OTHER], notifiedCustomersAt: AT }),
        record('mine-draft', { affectedOrgIds: [ORG] }),
        record('theirs', { affectedOrgIds: [OTHER], notifiedCustomersAt: AT }),
      ],
      ORG,
    );
    expect(views.map((v) => [v.id, v.affectsWorkspace])).toEqual([
      ['pub', false],
      ['mine', true],
    ]);
    expect(Object.keys(views[1] ?? {}).sort()).toEqual([
      'affectsWorkspace',
      'body',
      'component',
      'id',
      'resolvedAt',
      'startedAt',
      'status',
      'title',
    ]);
  });

  it('refuses a caller without org.manage before reading', async () => {
    let read = false;
    const service = new WorkspaceIncidentsService({
      listForWorkspaces: async () => ((read = true), []),
    });
    const context = { organizationId: ORG, capabilities: [], correlationId: 'c' } as unknown;
    await expect(service.list(context as TenantContext)).rejects.toMatchObject({ status: 403 });
    expect(read).toBe(false);
  });
});
