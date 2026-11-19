import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_ACTION_CATALOG,
  ACTIVITY_SOURCES,
  type ActivitySource,
  type Principal,
} from '@tmanage/domain';
import {
  SOURCE_READ_CAPABILITY,
  factKeyOf,
  factSourceOf,
  mayReadEntry,
} from './activity-resolver.js';
import { SOURCE_FACTS_SQL, type ActivitySourceFacts } from './activity.repository.js';

/**
 * 62-A2 (B02) — the per-entry read rule, one case per source, with the real `authorize()`.
 * The parent check is the service's; this is the second gate every entry passes.
 */

const ORG = '0199aa00-0000-7000-8000-00000000000a';
const ON = '0199aa00-0000-7000-8000-0000000000p1';
const OFF = '0199aa00-0000-7000-8000-0000000000p2';

function principal(
  role: Principal['role'],
  projectIds: readonly string[],
  orgWide = false,
): Principal {
  return {
    userId: '0199aa00-0000-7000-8000-0000000000u1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '0199aa00-0000-7000-8000-0000000000m1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: orgWide,
  };
}

const owner = principal('owner', [], true);
const memberOn = principal('member', [ON]);
const managerOn = principal('manager', [ON]);

const facts = (
  projectId: string | null,
  audience: ActivitySourceFacts['audience'] = 'internal',
): ActivitySourceFacts => ({
  subject: null,
  id: 'row-1',
  projectId,
  clientOrganizationId: null,
  audience,
});

const NON_FINANCE: readonly ActivitySource[] = [
  'project',
  'project_membership',
  'work_item',
  'time_log',
  'deliverable',
  'project_milestone',
];

describe('activity resolver (62-A2)', () => {
  it('names one read capability per source, and every source has a facts statement', () => {
    expect(Object.keys(SOURCE_READ_CAPABILITY).sort()).toEqual([...ACTIVITY_SOURCES].sort());
    for (const source of ACTIVITY_SOURCES) {
      const sql = SOURCE_FACTS_SQL[factSourceOf(source)](2);
      expect(sql, source).toMatch(/organization_id = \? and \w+\.id in \(\?, \?\)/);
      // D2: the row's name comes back as `subject` and nothing else of its content does.
      const selected = sql.split(/\sfrom\s/)[0]!.trimEnd();
      expect(selected, source).toMatch(/ as subject$/);
      expect(sql.replace(/\w+\.(title|name|number) as subject/, ''), source).not.toMatch(
        /title|name|body|feedback|amount|note|description/i,
      );
    }
  });

  it('reads a membership through its project and every other source through its own row', () => {
    expect(factSourceOf('project_membership')).toBe('project');
    expect(factKeyOf('project_membership', { objectId: 'm-1', projectId: ON })).toBe(ON);
    expect(factKeyOf('work_item', { objectId: 'w-1', projectId: ON })).toBe('w-1');
  });

  it.each(NON_FINANCE)('%s: readable on the project, not off it', (source) => {
    expect(mayReadEntry(owner, ORG, source, false, facts(OFF))).toBe(true);
    expect(mayReadEntry(memberOn, ORG, source, false, facts(ON))).toBe(true);
    expect(mayReadEntry(memberOn, ORG, source, false, facts(OFF))).toBe(false);
  });

  it('file_asset: follows the file read rule (file.download on the project)', () => {
    expect(mayReadEntry(memberOn, ORG, 'file_asset', false, facts(ON, 'client_visible'))).toBe(
      true,
    );
    expect(mayReadEntry(memberOn, ORG, 'file_asset', false, facts(OFF))).toBe(false);
  });

  it('approval: follows the approval read rule', () => {
    expect(mayReadEntry(memberOn, ORG, 'approval', false, facts(ON, 'client_visible'))).toBe(true);
    expect(mayReadEntry(memberOn, ORG, 'approval', false, facts(OFF, 'client_visible'))).toBe(
      false,
    );
  });

  it('client_request: needs the triage capability', () => {
    expect(mayReadEntry(owner, ORG, 'client_request', false, facts(ON, 'client_visible'))).toBe(
      true,
    );
    expect(
      mayReadEntry(managerOn, ORG, 'client_request', false, facts(OFF, 'client_visible')),
    ).toBe(false);
  });

  it.each(['client_invoice', 'quote', 'expense'] as const)('%s: needs finance.view', (source) => {
    expect(mayReadEntry(owner, ORG, source, true, facts(ON))).toBe(true);
    expect(mayReadEntry(managerOn, ORG, source, true, facts(ON))).toBe(true);
    expect(mayReadEntry(memberOn, ORG, source, true, facts(ON))).toBe(false);
  });

  it('a finance entry on a project source (budget) still needs finance.view', () => {
    expect(ACTIVITY_ACTION_CATALOG['budget.updated'].finance).toBe(true);
    expect(mayReadEntry(memberOn, ORG, 'project', true, facts(ON))).toBe(false);
    expect(mayReadEntry(managerOn, ORG, 'project', true, facts(ON))).toBe(true);
  });

  it('another tenant is never readable, whatever the role', () => {
    for (const action of ACTIVITY_ACTIONS) {
      const { source, finance } = ACTIVITY_ACTION_CATALOG[action];
      expect(mayReadEntry(owner, 'another-organization', source, finance, facts(ON)), action).toBe(
        false,
      );
    }
  });
});
