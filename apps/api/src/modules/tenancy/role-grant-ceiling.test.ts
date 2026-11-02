import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '@tmanage/domain';
import { requireClientCeiling } from './role-grant-ceiling.js';

/** 56-28 — a custom client role carrying an internal capability is refused 422 `client_ceiling`. */
describe('56-28 requireClientCeiling', () => {
  it('refuses project.manage on a client-based custom role, naming the token', () => {
    const run = () =>
      requireClientCeiling(
        'client_member',
        [...capabilitiesFor('client_member'), 'project.manage'],
        'role.create',
      );
    expect(run).toThrow(
      expect.objectContaining({
        status: 422,
        code: 'client_ceiling',
        details: [{ field: 'capabilities', message: 'project.manage' }],
      }),
    );
    expect(() =>
      requireClientCeiling('client_admin', capabilitiesFor('client_admin'), 'x'),
    ).not.toThrow();
  });
});
