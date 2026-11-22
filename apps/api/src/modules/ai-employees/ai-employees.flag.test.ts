import type { Principal } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { NEVER, OPS } from '../ai-actions/registry/index.js';
import { buildAiOpenApiDocument } from '../ai-actions/openapi.js';
import { buildToolCatalog } from '../mcp/tool-catalog.js';
import {
  AI_EMPLOYEES_SWITCH,
  AiEmployeesService,
  aiEmployeesEnabled,
  type AiEmployeesServiceOptions,
} from './ai-employees.service.js';

/**
 * Master stays deployable: the AI-employee surface is behind the server switch
 * `TMANAGE_AI_EMPLOYEES=on`, off by default. Off = 404 `not_found` on every route before any read
 * or write; in both states the routes are absent from the MCP catalog and `/openapi/ai.json`.
 * The "on" behaviour itself is `ai-employees.service.test.ts`.
 */

const PATH = '/ai-employees';
const ID = '0190a000-0000-7000-8000-0000000000d1';

function touched(): { calls: string[]; options: AiEmployeesServiceOptions } {
  const calls: string[] = [];
  const spy = (name: string) => () => {
    calls.push(name);
    throw new Error(`${name} must not run while the switch is off`);
  };
  const options = {
    database: {
      transaction: spy('transaction'),
      read: spy('read'),
      aiEmployeeHireTransaction: spy('aiEmployeeHireTransaction'),
    },
    audit: { record: spy('audit') },
    repository: {},
    memberships: {},
    accounts: { insertUser: spy('insertUser') },
    agentKeys: {},
    enabled: false,
  } as unknown as AiEmployeesServiceOptions;
  return { calls, options };
}

const CONTEXT = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  principalKind: 'internal',
  capabilities: ['ai_employee.manage', 'people.view'],
} as unknown as TenantContext;
const PRINCIPAL = { kind: 'internal', role: 'owner' } as unknown as Principal;

describe('the server switch', () => {
  it('is on only for the exact value "on"', () => {
    expect(aiEmployeesEnabled({})).toBe(false);
    for (const value of ['', 'off', 'ON', 'true', '1', ' on']) {
      expect(aiEmployeesEnabled({ [AI_EMPLOYEES_SWITCH]: value }), value).toBe(false);
    }
    expect(aiEmployeesEnabled({ [AI_EMPLOYEES_SWITCH]: 'on' })).toBe(true);
  });
});

describe('switch off: every route is 404 and nothing runs', () => {
  const routes: readonly [string, (s: AiEmployeesService) => Promise<unknown>][] = [
    ['list', (s) => s.list(CONTEXT, PRINCIPAL)],
    ['get', (s) => s.get(CONTEXT, PRINCIPAL, ID)],
    ['hire', (s) => s.hire(CONTEXT, PRINCIPAL, { displayName: 'Mat', jobTitle: 'x' })],
    ['update', (s) => s.update(CONTEXT, PRINCIPAL, ID, { version: 1, jobTitle: 'x' })],
    ['pause', (s) => s.pause(CONTEXT, PRINCIPAL, ID, { version: 1 })],
    ['resume', (s) => s.resume(CONTEXT, PRINCIPAL, ID, { version: 1 })],
    [
      'sponsor',
      (s) => s.changeSponsor(CONTEXT, PRINCIPAL, ID, { version: 1, sponsorMembershipId: ID }),
    ],
    ['retire', (s) => s.retire(CONTEXT, PRINCIPAL, ID, { version: 1 })],
    ['listKeys', (s) => s.listKeys(CONTEXT, PRINCIPAL, ID)],
    ['createKey', (s) => s.createKey(CONTEXT, PRINCIPAL, ID, { name: 'k', lifetimeDays: 30 })],
    ['rotateKey', (s) => s.rotateKey(CONTEXT, PRINCIPAL, ID, ID, { name: 'k', lifetimeDays: 30 })],
    ['revokeKey', (s) => s.revokeKey(CONTEXT, PRINCIPAL, ID, ID)],
  ];

  for (const [name, call] of routes) {
    it(name, async () => {
      const { calls, options } = touched();
      const error = await call(new AiEmployeesService(options)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 404,
        code: 'not_found',
        auditCode: 'feature.ai_employees_off',
      });
      expect(calls).toEqual([]);
    });
  }

  it('an API-key caller gets the same 404 (the switch answers before the person-only door)', async () => {
    const { options } = touched();
    const keyContext = { ...CONTEXT, actorChannel: 'pat' } as unknown as TenantContext;
    await expect(new AiEmployeesService(options).list(keyContext, PRINCIPAL)).rejects.toMatchObject(
      {
        status: 404,
      },
    );
  });
});

describe('absent from AI discovery in both states', () => {
  it('no registry op is an /ai-employees route; all 12 routes are NEVER', () => {
    expect(OPS.filter((op) => op.path.includes(PATH))).toEqual([]);
    expect(NEVER.filter((entry) => entry.path.includes(PATH))).toHaveLength(12);
    expect(
      NEVER.filter((entry) => entry.path.includes(PATH)).every(
        (entry) => entry.reason === 'ai_employee_admin',
      ),
    ).toBe(true);
  });

  it('the full MCP catalog for every scope and capability has no AI-employee tool', () => {
    const catalog = buildToolCatalog({
      profile: 'full',
      scopes: ['read', 'write', 'manage', 'billing'],
      capabilities: new Set(['ai_employee.manage', 'ai_employee.assign', 'people.view']),
    });
    expect(catalog.tools.filter((tool) => /ai[_-]employee/.test(tool.name))).toEqual([]);
  });

  it('/openapi/ai.json lists no /ai-employees path', () => {
    const document = buildAiOpenApiDocument();
    expect(
      Object.keys(document['paths'] as Record<string, unknown>).filter((path) =>
        path.includes(PATH),
      ),
    ).toEqual([]);
  });
});
