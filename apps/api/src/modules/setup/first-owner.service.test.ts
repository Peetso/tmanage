import { describe, expect, it, vi } from 'vitest';
import type {
  FirstOwnerScope,
  FirstOwnerTransactionOptions,
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { CredentialsRepository } from '../identity/credentials.repository.js';
import type * as PasswordModule from '../identity/password.js';
import type { ProvisioningService } from '../tenancy/provisioning.service.js';
import type { FirstOwnerRepository } from './first-owner.repository.js';
import {
  FirstOwnerService,
  FirstOwnerSetupUnavailableError,
  FirstOwnerTokenRejectedError,
  type FirstOwnerSetupBody,
} from './first-owner.service.js';

// argon2 is slow on purpose; the service's ordering, not the hash, is under test here.
vi.mock('../identity/password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PasswordModule>();
  return { ...actual, hashPassword: vi.fn(async () => 'hashed-password') };
});

const TOKEN = 'a-setup-token-that-is-at-least-32-characters';

const BODY: FirstOwnerSetupBody = {
  setupToken: TOKEN,
  email: 'founder@example.com',
  displayName: 'Founder Person',
  password: 'correct horse battery staple 9',
  organizationName: 'Acme Studio',
  slug: 'acme-studio',
  timezone: 'UTC',
  defaultLocale: 'en',
};

interface Harness {
  service: FirstOwnerService;
  calls: string[];
  transaction: ReturnType<typeof vi.fn>;
  insertUser: ReturnType<typeof vi.fn>;
}

/**
 * Fakes for every collaborator. `state.organizations` is what `countExisting` reports; the
 * fake transaction serializes on a promise-chain lock (as GET_LOCK does) and flips the count
 * once a unit of work commits.
 */
function harness(initialOrganizations = 0): Harness {
  const calls: string[] = [];
  const state = { organizations: initialOrganizations };
  const runner = {} as TenantQueryRunner;
  let lock: Promise<unknown> = Promise.resolve();

  const transaction = vi.fn(
    async <T>(
      _options: FirstOwnerTransactionOptions,
      work: (scope: FirstOwnerScope) => Promise<T>,
    ): Promise<T> => {
      const run = lock.then(async () => {
        const scope: FirstOwnerScope = {
          bootstrap: runner,
          identity: runner,
          tenant: (_context: TenantContext) => runner,
        };
        const result = await work(scope);
        state.organizations += 1; // committed
        return result;
      });
      lock = run.catch(() => undefined);
      return run;
    },
  );

  const database = {
    firstOwnerTransaction: transaction,
    bootstrapRead: vi.fn(async (_options: unknown, work: (r: TenantQueryRunner) => unknown) =>
      work(runner),
    ),
  } as unknown as TenantDatabase;

  const insertUser = vi.fn(async () => {
    calls.push('insertUser');
  });
  const repository = {
    countExisting: vi.fn(async () => {
      // Yield, so two concurrent callers would interleave here without the lock.
      await Promise.resolve();
      return { organizations: state.organizations, owners: state.organizations };
    }),
    insertUser,
  } as unknown as FirstOwnerRepository;

  const credentials = {
    setPassword: vi.fn(async () => {
      calls.push('setPassword');
    }),
  } as unknown as CredentialsRepository;

  const provisioning = {
    provisionFounderWithin: vi.fn(
      async (_runnerFor: unknown, input: { slug: string; name: string }) => {
        calls.push('provisionFounderWithin');
        return {
          organizationId: 'org-1',
          slug: input.slug,
          name: input.name,
          workspaceId: 'ws-1',
          membershipId: 'm-1',
          role: 'owner',
        };
      },
    ),
  } as unknown as ProvisioningService;

  const service = new FirstOwnerService(database, provisioning, TOKEN, repository, credentials);
  return { service, calls, transaction, insertUser };
}

describe('FirstOwnerService.setup', () => {
  it('rejects a wrong token before opening a transaction', async () => {
    const h = harness();
    await expect(h.service.setup({ ...BODY, setupToken: 'wrong' }, 'c-1')).rejects.toBeInstanceOf(
      FirstOwnerTokenRejectedError,
    );
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('refuses once an organization exists, without inserting a user', async () => {
    const h = harness(1);
    await expect(h.service.setup(BODY, 'c-1')).rejects.toBeInstanceOf(
      FirstOwnerSetupUnavailableError,
    );
    expect(h.insertUser).not.toHaveBeenCalled();
  });

  it('creates the user, then the password, then the organization', async () => {
    const h = harness();
    const result = await h.service.setup(BODY, 'c-1');
    expect(h.calls).toEqual(['insertUser', 'setPassword', 'provisionFounderWithin']);
    expect(result).toMatchObject({ slug: 'acme-studio', organizationId: 'org-1' });
  });

  it('lets exactly one of two concurrent setups succeed', async () => {
    const h = harness();
    const outcomes = await Promise.allSettled([
      h.service.setup(BODY, 'c-1'),
      h.service.setup(BODY, 'c-2'),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      FirstOwnerSetupUnavailableError,
    );
    expect(h.insertUser).toHaveBeenCalledTimes(1);
  });
});
