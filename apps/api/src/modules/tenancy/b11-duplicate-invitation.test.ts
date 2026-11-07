import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ApiError } from '../../common/http/errors.js';
import { INVITATION_ALREADY_PENDING, requireNoOpenInvitation } from './invitations.controller.js';
import type { InvitationsRepository } from './invitations.repository.js';

/** B11 — one open invitation per address per organization, refused with a named code. */
describe('requireNoOpenInvitation', () => {
  const context = { organizationId: 'org-1' } as TenantContext;
  const database = {
    read: (_context: TenantContext, work: (runner: unknown) => unknown) => work({}),
  } as unknown as TenantDatabase;

  it('refuses an address with any open invitation (409) and passes a fresh one', async () => {
    const repository = {
      findPendingForEmail: vi.fn((_runner: unknown, _context: unknown, email: string) =>
        Promise.resolve(email === 'qa1@example.com' ? [{ id: 'inv-1' }] : []),
      ),
    } as unknown as InvitationsRepository;

    const refused = await requireNoOpenInvitation(
      database,
      context,
      'qa1@example.com',
      repository,
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ApiError);
    expect(refused).toMatchObject({
      status: 409,
      details: [{ field: 'email', message: INVITATION_ALREADY_PENDING }],
    });
    await expect(
      requireNoOpenInvitation(database, context, 'new@example.com', repository),
    ).resolves.toBeUndefined();
  });
});
