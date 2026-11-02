import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ImportController } from './import.controller.js';
import type { ImportService } from './import.service.js';
import type { JiraFetch } from './jira-rest.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

/** R22-e — `POST …/imports/sources/jira`: the SSRF rule and the capability, database-free. */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG } as unknown as TenantContext;

function owner(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-0000-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function client(): Principal {
  return {
    ...owner(),
    kind: 'client',
    role: 'client_admin',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    hasOrgWideScope: false,
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  baseUrl: 'https://acme.atlassian.net',
  email: 'ana@acme.test',
  token: 'secret-token',
  projectKey: 'WEB',
  ...over,
});

function controller(fetch: JiraFetch): ImportController {
  return new ImportController({} as ImportService, fetch);
}

describe('ImportController.jiraSource (R22-e)', () => {
  it('refuses an http:// site with 422 and makes no request', async () => {
    const fetch = vi.fn<JiraFetch>();
    const error = await controller(fetch)
      .jiraSource(context, owner(), body({ baseUrl: 'http://acme.atlassian.net' }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a client principal with 403 before any request', async () => {
    const fetch = vi.fn<JiraFetch>();
    const error = await controller(fetch)
      .jiraSource(context, client(), body())
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, ImportController.prototype.jiraSource)).toBe(
      'org.manage',
    );
  });

  it('returns jira_issues rows with the project JQL', async () => {
    const fetch = vi.fn<JiraFetch>(
      async () =>
        new Response(
          JSON.stringify({ total: 1, issues: [{ key: 'WEB-1', fields: { summary: 'a' } }] }),
        ),
    );
    const view = await controller(fetch).jiraSource(context, owner(), body());
    expect(view.sourceKind).toBe('jira_issues');
    expect(view.rows).toEqual([{ 'Issue key': 'WEB-1', Summary: 'a' }]);
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('jql')).toBe(
      'project = WEB ORDER BY created ASC',
    );
  });

  it('refuses both cursors at once and a bad nextPageToken with 400', async () => {
    const fetch = vi.fn<JiraFetch>();
    for (const over of [
      { startAt: 100, nextPageToken: 'p2' },
      { nextPageToken: 'x'.repeat(3000) },
      { nextPageToken: 'a\u0000b' },
    ]) {
      const error = await controller(fetch)
        .jiraSource(context, owner(), body(over))
        .catch((e: unknown) => e);
      expect((error as ApiError).status).toBe(400);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes the nextPageToken through and returns the new cursor', async () => {
    const fetch = vi.fn<JiraFetch>(
      async () => new Response(JSON.stringify({ issues: [], isLast: true, names: { a: 'A' } })),
    );
    const view = await controller(fetch).jiraSource(
      context,
      owner(),
      body({ nextPageToken: 'p2' }),
    );
    expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('nextPageToken')).toBe('p2');
    expect(view).toMatchObject({ nextPageToken: null, nextStartAt: null, total: null });
  });
});
