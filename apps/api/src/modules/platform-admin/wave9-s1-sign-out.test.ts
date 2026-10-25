import { describe, expect, it } from 'vitest';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import { BEARER_CUTOFF_BOOTSTRAP_REASON } from '../identity/bearer-credentials.js';
import { PlatformAdminRepository } from './platform-admin.repository.js';

/**
 * Wave 9, lane S1, F19: the platform operator's "sign out everywhere" used to end only the
 * person's sessions. It now also runs the bearer cutoff (personal access tokens and AI app
 * grants, every organization) before and after the session cutoff.
 */

const USER = '0198f0dd-0000-7000-8000-000000000001';
const AUDIT = {
  actorUserId: '0198f0dd-0000-7000-8000-000000000002',
  actorEmail: 'operator@example.test',
  action: 'platform.user.sign_out_everywhere',
  targetType: 'user' as const,
  targetId: USER,
  targetLabel: 'Sara',
  reason: 'Account recovery',
  correlationId: '0198f0dd-0000-7000-8000-0000000000c1',
};

describe('F19: platform sign-out-everywhere ends bearer credentials too', () => {
  it('runs the bearer cutoff around the session cutoff', async () => {
    const steps: string[] = [];
    const database = {
      bootstrapRead: (options: { reason: string; tables: readonly string[] }) => {
        expect(options.reason).toBe(BEARER_CUTOFF_BOOTSTRAP_REASON);
        expect(options.tables).toEqual(['personal_access_tokens', 'oauth_grants']);
        steps.push('bearer-cutoff');
        // No organization holds a live token or grant: nothing further to revoke.
        return Promise.resolve([]);
      },
      identityTransaction: <T>(
        _options: unknown,
        work: (tx: { query: () => Promise<unknown> }) => Promise<T>,
      ) => {
        steps.push('session-cutoff');
        return work({ query: () => Promise.resolve({ affectedRows: 3 }) });
      },
    } as unknown as TenantDatabase;

    const ended = await new PlatformAdminRepository(database).signOutEverywhere(USER, AUDIT);

    expect(ended).toBe(3);
    expect(steps).toEqual(['bearer-cutoff', 'session-cutoff', 'bearer-cutoff']);
  });

  it('refuses the whole action when the bearer cutoff cannot run', async () => {
    let sessionCutoffRan = false;
    const database = {
      bootstrapRead: () => Promise.reject(new Error('database unavailable')),
      identityTransaction: () => {
        sessionCutoffRan = true;
        return Promise.resolve(0);
      },
    } as unknown as TenantDatabase;

    await expect(
      new PlatformAdminRepository(database).signOutEverywhere(USER, AUDIT),
    ).rejects.toThrow('database unavailable');
    expect(sessionCutoffRan).toBe(false);
  });
});
