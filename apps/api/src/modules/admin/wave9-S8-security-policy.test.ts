import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Principal, Role } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { TwoStepRequirementGuard } from '../../common/http/guards/two-step-requirement.guard.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SecuritySettingsRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { OrgSettingsController } from '../tenancy/org-settings.controller.js';
import { OWNER_ONLY_SETTING_KEYS } from '../tenancy/org-settings.allowlist.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import { SecuritySettingsController } from './security.controller.js';
import type { SecuritySettingsRepository } from './security.repository.js';

/**
 * Wave 9 S8 — audit F09 (the Admin Security "Require two-factor authentication" switch was saved but
 * never enforced) and F12b (the same policy was writable through the everyday generic settings
 * route). Over fakes with the real `authorize`, the real guard and both real controllers sharing one
 * in-memory `org_settings` store, so "the switch the screen sets is the switch the guard reads" is a
 * fact about the code, not a mock of it.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBER_USER = '00000000-0000-4000-8000-0000000000c2';

function principal(role: Role, userId = OWNER_USER): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '00000000-0000-4000-8000-0000000000e1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = {
  organizationId: ORG,
  userId: OWNER_USER,
  membershipId: '00000000-0000-4000-8000-0000000000e1',
  correlationId: 'c-s8',
} as unknown as TenantContext;

/** One in-memory `org_settings` table, shared by every controller and the guard. */
function world() {
  const store = new Map<string, string>();
  const orgSettings = {
    resolveOrganization: async () => ({ id: ORG }),
    listAll: async () =>
      [...store].map(([settingKey, settingValue]) => ({ settingKey, settingValue })),
    findByKey: async (_r: unknown, _c: unknown, key: string) =>
      store.has(key) ? { settingKey: key, settingValue: store.get(key)! } : undefined,
    upsert: vi.fn(async (_r: unknown, _c: unknown, input: { key: string; value: string }) => {
      store.set(input.key, input.value);
    }),
  };
  let securityRow: SecuritySettingsRow | undefined;
  const security = {
    resolveOrganization: async () => ({ id: ORG }),
    find: async () => securityRow,
    upsert: vi.fn(
      async (
        _r: unknown,
        _c: unknown,
        input: { enforce2fa: boolean; ipAllowlist: readonly string[] },
      ) => {
        securityRow = {
          enforce2fa: input.enforce2fa,
          ipAllowlistJson: [...input.ipAllowlist],
        } as unknown as SecuritySettingsRow;
      },
    ),
  };
  const audit = { record: vi.fn(async () => ({})) };
  /** `enrolled` is what the second-factor presence read answers for whoever asks. */
  const database = (enrolled: boolean) =>
    ({
      read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
      transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
      identityRead: async () => enrolled,
    }) as unknown as TenantDatabase;
  const securityController = new SecuritySettingsController(
    database(true),
    audit as unknown as Pick<AuditService, 'record'>,
    security as unknown as SecuritySettingsRepository,
    orgSettings as unknown as OrgSettingsRepository,
  );
  const generic = new OrgSettingsController(
    database(true),
    orgSettings as unknown as OrgSettingsRepository,
  );
  const guard = new TwoStepRequirementGuard(
    { getAllAndOverride: () => false } as never,
    database(false), // the member asking has no second factor
    orgSettings as unknown as OrgSettingsRepository,
  );
  return { store, orgSettings, security, audit, securityController, generic, guard };
}

function memberRequest(): ExecutionContext {
  const request = { url: '/v1/organizations/acme/projects', params: { orgSlug: 'acme' } };
  const state = requireRequestState(request);
  state.session = { sessionId: 's-member', userId: MEMBER_USER } as NonNullable<
    typeof state.session
  >;
  state.tenant = { ...context, userId: MEMBER_USER } as TenantContext;
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).status;
}

describe('wave9-S8 F09: the Admin Security switch is the enforced switch', () => {
  it('owner turns enforce2fa on → an un-enrolled member gets 403 two_step_required on a tenant route', async () => {
    const w = world();
    // Before: the member passes.
    await expect(w.guard.canActivate(memberRequest())).resolves.toBe(true);

    const view = await w.securityController.set(context, principal('owner'), {
      enforce2fa: true,
      ipAllowlist: [],
    });
    expect(view.enforce2fa).toBe(true);
    expect(w.store.get('require_two_step')).toBe('true');

    await expect(w.guard.canActivate(memberRequest())).rejects.toMatchObject({
      status: 403,
      code: 'two_step_required',
    });
    // The read-back is the enforced store, and the change is audited with it.
    expect((await w.securityController.read(context, principal('org_admin'))).enforce2fa).toBe(
      true,
    );
    expect(w.audit.record).toHaveBeenCalledWith(
      {},
      context,
      expect.objectContaining({
        action: 'organization.security_settings_changed',
        metadata: { previous_two_step: false, two_step: true, allowlist_count: 0 },
      }),
    );
  });

  it('an org_admin (org.manage, not owner) is refused the write with 403 and nothing changes', async () => {
    const w = world();
    expect(
      await statusOf(
        w.securityController.set(context, principal('org_admin'), {
          enforce2fa: false,
          ipAllowlist: [],
        }),
      ),
    ).toBe(403);
    expect(w.orgSettings.upsert).not.toHaveBeenCalled();
    expect(w.security.upsert).not.toHaveBeenCalled();
    expect(w.audit.record).not.toHaveBeenCalled();
  });

  it('an absent ipAllowlist keeps the stored trusted networks', async () => {
    const w = world();
    await w.securityController.set(context, principal('owner'), {
      enforce2fa: false,
      ipAllowlist: ['203.0.113.0/24'],
    });
    const view = await w.securityController.set(context, principal('owner'), { enforce2fa: true });
    expect(view.ipAllowlist).toEqual(['203.0.113.0/24']);
  });
});

describe('wave9-S8 F12b: require_two_step is not an everyday setting', () => {
  it('is an owner-only key', () => {
    expect(OWNER_ONLY_SETTING_KEYS).toContain('require_two_step');
  });

  it('the generic PUT settings/require_two_step is 403 for the owner and for an org_admin, with no write', async () => {
    const w = world();
    w.store.set('require_two_step', 'true');
    for (const role of ['owner', 'org_admin'] as const) {
      expect(
        await statusOf(
          w.generic.set(context, principal(role), 'require_two_step', { value: false }),
        ),
      ).toBe(403);
    }
    expect(w.orgSettings.upsert).not.toHaveBeenCalled();
    expect(w.store.get('require_two_step')).toBe('true');
    // The owner's security route is the one writer, and it still works.
    await w.securityController.set(context, principal('owner'), { enforce2fa: false });
    expect(w.store.get('require_two_step')).toBe('false');
  });
});
