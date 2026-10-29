import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/http/errors.js';
import { PLATFORM_PERMISSION_METADATA } from '../require-platform-permission.decorator.js';
import { OWNER_OVERRIDE_MESSAGE } from '../../tenancy/override-ceiling.js';
import { PlatformMemberPermissionsController } from './member-permissions.controller.js';
import { MEMBER, ORG, actor, harness, member, request } from './test-fakes.js';

/** PA-04 · D8 platform member permission routes. */

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();

describe('PlatformMemberPermissionsController permissions', () => {
  it('reads with platform.orgs.view and writes with platform.permissions.edit', () => {
    const proto = PlatformMemberPermissionsController.prototype;
    expect(Reflect.getMetadata(PLATFORM_PERMISSION_METADATA, proto.read)).toBe(
      'platform.orgs.view',
    );
    expect(Reflect.getMetadata(PLATFORM_PERMISSION_METADATA, proto.effective)).toBe(
      'platform.orgs.view',
    );
    expect(Reflect.getMetadata(PLATFORM_PERMISSION_METADATA, proto.replace)).toBe(
      'platform.permissions.edit',
    );
  });
});

describe('overrides', () => {
  it('refuses overrides on an owner with 400 and the spec sentence', async () => {
    const h = harness({ member: member({ role: 'owner', hasOrgWideScope: true }) });
    const error = await refusal(
      h.service.replaceOverrides(
        actor,
        ORG,
        MEMBER,
        { overrides: [{ capability: 'work.delete', effect: 'deny' }] },
        request,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.message).toBe(OWNER_OVERRIDE_MESSAGE);
    expect(h.overrides.replace).not.toHaveBeenCalled();
  });

  it('refuses an internal-only permission for a client contact', async () => {
    const h = harness({
      member: member({
        kind: 'client',
        role: 'client_member',
        clientOrganizationId: '0199aa00-0000-7000-8000-0000000000aa',
      }),
    });
    const error = await refusal(
      h.service.replaceOverrides(
        actor,
        ORG,
        MEMBER,
        { overrides: [{ capability: 'work.delete', effect: 'allow' }] },
        request,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.auditCode).toBe('platform.member_overrides:internal_only');
  });

  it('refuses an expiry in the past', async () => {
    const h = harness({ member: member() });
    const error = await refusal(
      h.service.replaceOverrides(
        actor,
        ORG,
        MEMBER,
        {
          overrides: [
            { capability: 'work.delete', effect: 'allow', expiresAt: '2020-01-01T00:00:00Z' },
          ],
        },
        request,
      ),
    );
    expect(error.status).toBe(400);
    expect(error.details?.[0]?.field).toBe('overrides[0].expiresAt');
  });

  it('accepts an allow beyond any member ceiling (the platform grants as the owner) and audits both logs', async () => {
    const h = harness({ member: member() });
    const view = await h.service.replaceOverrides(
      actor,
      ORG,
      MEMBER,
      {
        overrides: [{ capability: 'billing.manage', effect: 'allow', expiresAt: FUTURE }],
        reason: 'Covering finance',
      },
      request,
    );
    expect(view.membershipId).toBe(MEMBER);
    expect(h.overrides.replace).toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'membership.permission_overrides_changed',
        effectiveActorId: actor.account.userId,
      }),
    );
    expect(h.platformAudit.build).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.member_overrides_changed',
        reason: 'Covering finance',
        reasonRequired: false,
      }),
    );
  });

  it('answers 404 for a member of another organization', async () => {
    const h = harness({});
    const error = await refusal(h.service.memberPermissions(ORG, MEMBER, undefined, request));
    expect(error.status).toBe(404);
  });
});

describe('effective permissions', () => {
  it('hides internal-only cells for a client contact', async () => {
    const h = harness({
      member: member({
        kind: 'client',
        role: 'client_member',
        clientOrganizationId: '0199aa00-0000-7000-8000-0000000000aa',
      }),
    });
    const view = await h.service.memberPermissions(ORG, MEMBER, undefined, request);
    expect(view.editable).toBe(false);
    expect(view.effective.permissions.some((entry) => entry.capability === 'work.delete')).toBe(
      false,
    );
  });

  it('marks an owner as not editable', async () => {
    const h = harness({ member: member({ role: 'owner', hasOrgWideScope: true }) });
    const view = await h.service.memberPermissions(ORG, MEMBER, undefined, request);
    expect(view.editable).toBe(false);
    expect(view.scope).toBe('org');
  });

  it('refuses a malformed projectId', async () => {
    const h = harness({ member: member() });
    expect((await refusal(h.service.effectivePermissions(ORG, MEMBER, 'x', request))).status).toBe(
      400,
    );
  });
});
