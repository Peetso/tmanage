import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@tmanage/domain';
import { controlCenterSectionsFor, menuEntryFor } from '../src/components/admin/ControlCenterShell';
import { capabilityLabel } from '../src/lib/capability-labels';

/** OPS-1's menu: the frame's groups and order; CQ-06: only what the role can open. */
function ids(role: string | undefined | null): string[] {
  return controlCenterSectionsFor(role).groups.flatMap((group) => group.items.map((i) => i.id));
}

describe('controlCenterSectionsFor', () => {
  it('draws the OPS-1 groups in the frame order, with the existing routes', () => {
    const { groups, foot } = controlCenterSectionsFor('owner');
    expect(groups.map((group) => group.labelKey)).toEqual([
      'ControlCenterShell.groupPeople',
      'ControlCenterShell.groupWorkSetup',
      'ControlCenterShell.groupTrust',
    ]);
    expect(groups.map((group) => group.items.map((item) => [item.id, item.href ?? null]))).toEqual([
      [
        ['overview', '/admin'],
        ['members', '/people'],
        ['roles', '/admin/roles'],
        ['client-organizations', null],
        ['invitations', '/people'],
      ],
      [
        ['templates', '/projects/templates'],
        ['fields', null],
        ['working-calendar', '/admin/working-calendar'],
        ['automations', '/automations'],
        ['integrations', '/automations/apps'],
        ['connected-apps', '/settings/connected-apps'],
      ],
      [
        ['security', '/admin/security'],
        // A17: workspace incidents sit right after Security.
        ['incidents', '/admin/incidents'],
        ['audit', '/admin/audit'],
        ['data', '/admin/audit/export'],
        ['storage', '/admin/storage'],
        // D5 (Figma F5): Privacy sits between Data and retention and Organization.
        ['privacy', '/admin/privacy'],
        ['organization', '/settings'],
        ['billing', '/billing'],
        // A10b: the finance home closes the last group.
        ['finance', '/finance'],
      ],
    ]);
    expect(foot).toEqual([]);
    expect(ids('org_admin')).toEqual(ids('owner'));
  });

  it('hides the pages a member would be refused, and everything gated while the role is unknown', () => {
    expect(ids('member')).toEqual(['members', 'connected-apps', 'audit']);
    expect(ids(undefined)).toEqual(['members']);
  });

  it('keeps the parent entry marked on sub-pages the frame does not list', () => {
    expect(menuEntryFor('sessions')).toBe('security');
    expect(menuEntryFor('offboarding')).toBe('members');
    expect(menuEntryFor('audit')).toBe('audit');
    expect(menuEntryFor('storage')).toBe('storage');
  });

  it('lists Storage (Google Drive) for an owner, linked to /admin/storage', () => {
    const items = controlCenterSectionsFor('owner').groups.flatMap((group) => group.items);
    expect(items.find((item) => item.href === '/admin/storage')?.id).toBe('storage');
    expect(ids('member')).not.toContain('storage');
  });

  it('names every capability in words', () => {
    for (const capability of CAPABILITIES) expect(capabilityLabel(capability)).not.toContain('.');
  });
});
