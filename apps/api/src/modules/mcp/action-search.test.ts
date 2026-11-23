import { describe, expect, it } from 'vitest';

import { allDetailsById } from './tool-catalog.js';
import { rankActions } from './action-search.js';

const catalogue = [...allDetailsById.entries()].map(([opId, detail]) => ({
  opId,
  title: detail.title,
  description: detail.description,
}));

const top = (query: string, n = 5) => rankActions(catalogue, query, n).map((a) => a.opId);

// 2026-11-23 live: "create a new project" returned no projects.create, so the AI said it could not.
describe('find actions by plain words', () => {
  it.each([
    ['create a new project', 'projects.create'],
    ['make a project', 'projects.create'],
    ['add a task', 'work_items.create'],
    ['invite an employee', 'invitations.create'],
    ['create a client company', 'client_organizations.create'],
    ["change a member's role", 'members.role.update'],
    ['delete a task', 'work_items.delete'],
    ['start the timer', 'time.timer.start'],
    ['list invoices', 'billing.invoices.list'],
  ])('"%s" finds %s near the top', (query, opId) => {
    expect(top(query)).toContain(opId);
  });

  it('never returns an action that matches no word', () => {
    expect(rankActions(catalogue, 'zzqx', 20)).toEqual([]);
    expect(rankActions(catalogue, '', 20)).toEqual([]);
  });

  it('puts an action matching every word ahead of a partial match', () => {
    const ranked = rankActions(
      [
        { opId: 'documents.create', title: 'Create a document', description: 'In a project.' },
        { opId: 'projects.create', title: 'Create a project', description: '' },
      ],
      'create project',
      2,
    ).map((a) => a.opId);
    expect(ranked[0]).toBe('projects.create');
  });
});
