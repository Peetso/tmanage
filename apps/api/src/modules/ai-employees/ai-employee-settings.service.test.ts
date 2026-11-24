import type { Principal } from '@tmanage/domain';
import { AI_EMPLOYEES_PER_WORKSPACE } from '@tmanage/domain';
import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import {
  AI_EMPLOYEE_SETTINGS_DEFAULTS,
  type AiEmployeeSettings,
} from './ai-employee-settings.repository.js';
import {
  AI_SETTINGS_AUDIT,
  AiEmployeeSettingsService,
  parseSettingsChange,
  type AiEmployeeSettingsServiceOptions,
} from './ai-employee-settings.service.js';

/**
 * 60-07 (S8) — the workspace's AI-employee settings with an in-memory store (IP-14). The SQL, the
 * grants and the tenant guard are proved by the DB test phase.
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const RUNNER = {} as TenantQueryRunner;

function contextOf(channel = false): TenantContext {
  return {
    organizationId: ORG,
    userId: '0190a000-0000-7000-8000-0000000000a1',
    principalKind: 'internal',
    membershipId: '0190a000-0000-7000-8000-0000000000b1',
    capabilities: ['ai_employee.manage'],
    policyVersion: '1',
    correlationId: '0190a000-0000-7000-8000-0000000000c1',
    ...(channel ? { actorChannel: 'ai_assistant' } : {}),
  } as unknown as TenantContext;
}

const OWNER = { role: 'owner', kind: 'internal' } as unknown as Principal;

function harness(enabled = true) {
  let stored: AiEmployeeSettings = AI_EMPLOYEE_SETTINGS_DEFAULTS;
  const audits: { action: string; objectId: string; metadata: unknown }[] = [];
  const run = (async (_c: TenantContext, work: (tx: TenantQueryRunner) => Promise<unknown>) =>
    work(RUNNER)) as unknown;
  const options: AiEmployeeSettingsServiceOptions = {
    database: {
      transaction: run as AiEmployeeSettingsServiceOptions['database']['transaction'],
      read: run as AiEmployeeSettingsServiceOptions['database']['read'],
    },
    audit: {
      record: (async (
        _tx: TenantQueryRunner,
        _c: TenantContext,
        input: { action: string; objectId: string; metadata: unknown },
      ) => {
        audits.push(input);
        return {};
      }) as unknown as AiEmployeeSettingsServiceOptions['audit']['record'],
    },
    settings: {
      read: async () => stored,
      save: async (_r, _c, expectedVersion, next) => {
        if (stored.version !== expectedVersion) return false;
        stored = { ...next, version: expectedVersion + 1 };
        return true;
      },
    },
    repository: { countLive: async () => 2 },
    enabled,
  };
  return { service: new AiEmployeeSettingsService(options), audits, stored: () => stored };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('60-07 AI-employee settings', () => {
  it('reads the defaults before anything was saved, with the beta cap and the live count', async () => {
    const view = await harness().service.get(contextOf(), OWNER);
    expect(view).toMatchObject({
      enabled: true,
      version: 0,
      limit: AI_EMPLOYEES_PER_WORKSPACE,
      live: 2,
      canEdit: true,
    });
  });

  it('saves a change on the version read, audits it once, and refuses a stale version', async () => {
    const h = harness();
    const view = await h.service.update(contextOf(), OWNER, {
      version: 0,
      enabled: false,
      clientWork: 'internal_only',
    });
    expect(view).toMatchObject({ enabled: false, clientWork: 'internal_only', version: 1 });
    expect(h.audits).toEqual([
      {
        action: AI_SETTINGS_AUDIT,
        result: 'allowed',
        objectId: ORG,
        actorUserId: contextOf().userId,
        metadata: { fields: 'clientWork,enabled', enabled: false, client_work: 'internal_only' },
      },
    ]);
    const stale = await refusal(
      h.service.update(contextOf(), OWNER, { version: 0, enabled: true }),
    );
    expect([stale.status, stale.auditCode]).toEqual([409, 'ai_employee_settings:stale_version']);
    expect(h.stored().enabled).toBe(false);
  });

  it('parses the body once: unknown values, no version and an empty change are refused', () => {
    expect(parseSettingsChange({ version: 1, hirePolicy: 'everyone' })).toMatchObject({
      ok: false,
    });
    expect(parseSettingsChange({ enabled: true })).toMatchObject({ ok: false });
    expect(parseSettingsChange({ version: 1 })).toMatchObject({ ok: false });
    expect(parseSettingsChange({ version: 1, enabled: 'yes' })).toMatchObject({ ok: false });
  });

  it('is a person-session page and does not exist while the server switch is off', async () => {
    const channel = await refusal(harness().service.get(contextOf(true), OWNER));
    expect(channel.status).toBe(403);
    const off = await refusal(harness(false).service.get(contextOf(), OWNER));
    expect(off.status).toBe(404);
  });
});
