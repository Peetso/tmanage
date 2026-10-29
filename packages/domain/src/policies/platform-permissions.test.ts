import { describe, expect, it } from 'vitest';
import {
  normalizePlatformPermissions,
  PLATFORM_PERMISSION_AREAS,
  PLATFORM_PERMISSIONS,
  PLATFORM_PRESETS,
  platformPermissionsFor,
} from './platform-permissions.js';

/** SPEC §3.1: 18 keys, three presets with exact sets, six areas covering every key once. */

describe('platform permissions', () => {
  it('lists the 18 keys of SPEC §3.1', () => {
    expect(PLATFORM_PERMISSIONS).toHaveLength(18);
    expect(new Set(PLATFORM_PERMISSIONS).size).toBe(18);
  });

  it('gives super_admin every key', () => {
    expect([...PLATFORM_PRESETS.super_admin]).toEqual([...PLATFORM_PERMISSIONS]);
    expect(platformPermissionsFor('super_admin', null)).toEqual([...PLATFORM_PERMISSIONS]);
  });

  it('gives support all orgs.* but lifecycle, people.*, content.*, activity.view/detail, permissions.edit', () => {
    expect([...PLATFORM_PRESETS.support]).toEqual([
      'platform.orgs.view',
      'platform.orgs.edit',
      'platform.orgs.enter',
      'platform.people.view',
      'platform.people.edit',
      'platform.people.security',
      'platform.people.roles',
      'platform.content.view',
      'platform.content.moderate',
      'platform.activity.view',
      'platform.activity.detail',
      'platform.permissions.edit',
    ]);
  });

  it('gives auditor every *.view plus activity.detail and activity.export', () => {
    expect([...PLATFORM_PRESETS.auditor]).toEqual([
      'platform.orgs.view',
      'platform.people.view',
      'platform.content.view',
      'platform.activity.view',
      'platform.activity.detail',
      'platform.activity.export',
    ]);
  });

  it('never gives team.manage outside super_admin, even when stored or custom', () => {
    expect(
      platformPermissionsFor('custom', ['platform.team.manage', 'platform.orgs.view']),
    ).toEqual(['platform.orgs.view']);
    expect(platformPermissionsFor('support', null, { support: ['platform.team.manage'] })).toEqual(
      [],
    );
  });

  it('reads a stored preset mapping over the code default', () => {
    expect(
      platformPermissionsFor('auditor', null, { auditor: ['platform.activity.view'] }),
    ).toEqual(['platform.activity.view']);
  });

  it('normalises: unknown keys drop, duplicates collapse, catalogue order', () => {
    expect(
      normalizePlatformPermissions([
        'platform.people.view',
        'x',
        'platform.orgs.view',
        'platform.orgs.view',
      ]),
    ).toEqual(['platform.orgs.view', 'platform.people.view']);
    expect(normalizePlatformPermissions('nope')).toEqual([]);
  });

  it('groups every key in exactly one area', () => {
    const all = PLATFORM_PERMISSION_AREAS.flatMap((area) => area.permissions);
    expect([...all].sort()).toEqual([...PLATFORM_PERMISSIONS].sort());
    expect(PLATFORM_PERMISSION_AREAS.map((area) => area.id)).toEqual([
      'organizations',
      'people',
      'content',
      'activity',
      'settings',
      'team',
    ]);
  });
});
