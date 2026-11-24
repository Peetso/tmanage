import type { Principal } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { NEVER, OPS } from '../ai-actions/registry/index.js';
import { buildAiOpenApiDocument } from '../ai-actions/openapi.js';
import {
  AiEmployeeConnectionsService,
  type AiEmployeeConnectionsServiceOptions,
} from './connections.service.js';
import { WorksAsService, type WorksAsServiceOptions } from './works-as.js';

/**
 * 60-07: master stays deployable. While the server switch `TMANAGE_AI_EMPLOYEES` is off, both
 * connections routes are 404 `not_found` before any read or write, the consent page's "works as"
 * list is empty (the ordinary consent, unchanged) and a "works as" approval is 404 before its
 * transaction writes anything. In both states the routes are NEVER in the AI registry and absent
 * from `/openapi/ai.json`.
 */

const ID = '0190a000-0000-7000-8000-0000000000d1';
const CONTEXT = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  membershipId: ID,
  principalKind: 'internal',
  capabilities: ['ai_employee.manage', 'people.view'],
} as unknown as TenantContext;
const PRINCIPAL = { kind: 'internal', role: 'owner' } as unknown as Principal;

function spies(): { calls: string[]; spy: (name: string) => () => never } {
  const calls: string[] = [];
  return {
    calls,
    spy: (name) => () => {
      calls.push(name);
      throw new Error(`${name} must not run while the switch is off`);
    },
  };
}

describe('switch off', () => {
  it('both connections routes are 404 and nothing runs', async () => {
    const { calls, spy } = spies();
    const service = new AiEmployeeConnectionsService({
      database: { read: spy('read'), transaction: spy('transaction') },
      audit: { record: spy('audit') },
      repository: { findById: spy('findById') },
      agentKeys: { list: spy('keys') },
      aiConnectors: { list: spy('connectors'), revoke: spy('revoke') },
      enabled: false,
    } as unknown as AiEmployeeConnectionsServiceOptions);
    for (const call of [
      service.list(CONTEXT, PRINCIPAL, ID),
      service.revokeConnector(CONTEXT, PRINCIPAL, ID, ID),
      // The switch answers before the person-only door, for a key too.
      service.list({ ...CONTEXT, actorChannel: 'pat' } as unknown as TenantContext, PRINCIPAL, ID),
    ]) {
      const error = await call.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 404,
        code: 'not_found',
        auditCode: 'feature.ai_employees_off',
      });
    }
    expect(calls).toEqual([]);
  });

  it('the consent page lists no AI employee, and a works-as approval is 404', async () => {
    const { calls, spy } = spies();
    const service = new WorksAsService({
      database: { read: spy('read') },
      audit: { record: spy('audit') },
      repository: { list: spy('list'), lockById: spy('lock'), findById: spy('find') },
      settings: { read: spy('settings') },
      summaries: spy('summaries'),
      enabled: false,
    } as unknown as WorksAsServiceOptions);
    expect(await service.options(CONTEXT)).toEqual({ aiEmployees: [] });
    await expect(service.binder(ID)({} as never, CONTEXT, 'grant')).rejects.toMatchObject({
      status: 404,
      auditCode: 'feature.ai_employees_off',
    });
    expect(calls).toEqual([]);
  });
});

describe('absent from AI discovery in both states', () => {
  const PATHS = [
    '/v1/organizations/:orgSlug/ai-employees/:aiEmployeeId/connections/',
    '/v1/organizations/:orgSlug/ai-employees/:aiEmployeeId/connections/connectors/:grantId',
  ];

  it('both routes are NEVER ai_employee_admin; the works-as list is NEVER oauth; no op', () => {
    for (const path of PATHS) {
      expect(NEVER.filter((entry) => entry.path === path).map((entry) => entry.reason)).toEqual([
        'ai_employee_admin',
      ]);
    }
    expect(
      NEVER.filter((entry) => entry.path === '/v1/organizations/:orgSlug/oauth/consent/works-as'),
    ).toEqual([
      {
        method: 'GET',
        path: '/v1/organizations/:orgSlug/oauth/consent/works-as',
        reason: 'oauth',
      },
    ]);
    expect(
      OPS.filter((op) => op.path.includes('/connections') && op.path.includes('ai-employees')),
    ).toEqual([]);
  });

  it('/openapi/ai.json lists neither', () => {
    const paths = Object.keys(buildAiOpenApiDocument()['paths'] as Record<string, unknown>);
    expect(paths.filter((path) => path.includes('/connections/connectors'))).toEqual([]);
    expect(paths.filter((path) => path.includes('works-as'))).toEqual([]);
  });
});
