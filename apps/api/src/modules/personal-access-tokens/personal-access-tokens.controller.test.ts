import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PersonalAccessTokensController } from './personal-access-tokens.controller.js';
import type { PersonalAccessTokensService } from './personal-access-tokens.service.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

/**
 * Security test (0202, manager-directed): managing tokens is a session-only action. A personal
 * access token must not create or revoke tokens — that would let a leaked token mint fresh
 * long-lived credentials, so revoking the leaked one would no longer end the access. The refusal
 * is the generic `forbidden`, and the service is never touched on the token path.
 */

const CONTEXT = { organizationId: 'o', userId: 'u' } as unknown as TenantContext;
const PRINCIPAL = { membershipId: 'm' } as unknown as Principal;

function controllerWith() {
  const create = vi.fn(async () => ({ id: 't1', token: 'tmanage_pat_x' }));
  const revoke = vi.fn(async () => undefined);
  const service = { create, revoke } as unknown as PersonalAccessTokensService;
  return { controller: new PersonalAccessTokensController(service), create, revoke };
}

describe('PersonalAccessTokensController — token management is session-only', () => {
  it('refuses create from a personal access token and never calls the service', async () => {
    const { controller, create } = controllerWith();
    await expect(
      controller.create(CONTEXT, PRINCIPAL, { name: 'laptop' }, 'personal_access_token'),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses revoke from a personal access token and never calls the service', async () => {
    const { controller, revoke } = controllerWith();
    await expect(
      controller.revoke(CONTEXT, PRINCIPAL, 't1', 'personal_access_token'),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('allows create and revoke from a cookie session', async () => {
    const { controller, create, revoke } = controllerWith();
    await expect(
      controller.create(CONTEXT, PRINCIPAL, { name: 'laptop' }, 'cookie'),
    ).resolves.toMatchObject({ id: 't1' });
    await expect(controller.revoke(CONTEXT, PRINCIPAL, 't1', 'cookie')).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledOnce();
  });
});
