import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@tmanage/domain';
import { controlCenterSectionsFor } from '../src/components/admin/ControlCenterShell';
import { capabilityLabel } from '../src/lib/capability-labels';

/** CQ-06: the Control section map offers only what the role can open; capabilities read as words. */
function hrefs(role: string | undefined | null): string[] {
  const { groups, foot } = controlCenterSectionsFor(role);
  return [...groups.flatMap((group) => group.items), ...foot].map((item) => item.href);
}

describe('controlCenterSectionsFor', () => {
  it('gives the organization admin every entry, and Automations opens the rule library', () => {
    expect(hrefs('org_admin')).toEqual(hrefs('owner'));
    expect(hrefs('owner')).toContain('/automations');
    expect(hrefs('owner')).not.toContain('/admin/automations/webhooks');
  });

  it('hides the pages a member would be refused, and everything gated while the role is unknown', () => {
    expect(hrefs('member')).toEqual(['/people', '/admin/audit']);
    expect(hrefs(undefined)).toEqual(['/people']);
  });

  it('names every capability in words', () => {
    for (const capability of CAPABILITIES) expect(capabilityLabel(capability)).not.toContain('.');
  });
});
