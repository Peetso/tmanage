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
    // FIX2 item 4: the person's own settings open the menu, so every settings page shares it.
    expect(groups.map((group) => group.labelKey)).toEqual([
      'SettingsHome.group.you',
      'SettingsHome.group.security',
      'SettingsHome.group.connections',
      'ControlCenterShell.groupPeople',
      'ControlCenterShell.groupWorkSetup',
      'ControlCenterShell.groupTrust',
    ]);
    expect(
      groups.slice(3).map((group) => group.items.map((item) => [item.id, item.href ?? null])),
    ).toEqual([
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
        // 56-07p: Public links follows the audit log (owner and admin only).
        ['public-links', '/admin/public-links'],
        ['data', '/admin/audit/export'],
        ['storage', '/admin/storage'],
        // D5 (Figma F5): Privacy sits between Data and retention and Organization.
        ['privacy', '/admin/privacy'],
        ['organization', '/settings/organization'],
        ['billing', '/billing'],
        // A10b: the finance home closes the last group.
        ['finance', '/finance'],
      ],
    ]);
    expect(foot).toEqual([]);
    expect(ids('org_admin')).toEqual(ids('owner'));
  });

  it('hides the pages a member would be refused, and everything gated while the role is unknown', () => {
    const own = [
      'settings-home',
      'preferences',
      'notifications',
      'display',
      'accessibility',
      'quiet-hours',
      'digest',
      'startup',
      'my-data',
      'sign-in-security',
      'two-step',
      'access-tokens',
      'calendar-connections',
      'ai-assistant',
      'inbound-mail',
    ];
    expect(ids('member')).toEqual([...own, 'members', 'connected-apps', 'audit']);
    expect(ids(undefined)).toEqual([...own, 'members']);
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
