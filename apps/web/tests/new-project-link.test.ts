import { describe, expect, it } from 'vitest';
import { canCreateProjects } from '../src/components/projects/NewProjectLink';

/**
 * "New project" is offered only to roles whose ceiling holds `project.create`. The API is still
 * the gate; this pins that the button is not shown to a role the API would refuse, and that it
 * is shown to the owner (the role that had no way to create a second project before).
 */
describe('canCreateProjects', () => {
  it('offers New project to owner, org admin, workspace admin and manager', () => {
    for (const role of ['owner', 'org_admin', 'workspace_admin', 'manager']) {
      expect(canCreateProjects(role)).toBe(true);
    }
  });

  it('does not offer it to members, guests, client roles, unknown or missing roles', () => {
    for (const role of ['member', 'guest', 'client_admin', 'client_viewer', 'nobody', undefined]) {
      expect(canCreateProjects(role)).toBe(false);
    }
  });
});
