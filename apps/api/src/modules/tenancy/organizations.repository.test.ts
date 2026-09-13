import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { unwrapQueryError } from '../../common/database/query-error.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { OrganizationSlugTakenError, OrganizationsRepository } from './organizations.repository.js';

/**
 * How the slug unique key becomes {@link OrganizationSlugTakenError}.
 *
 * The repository reads the driver error's string `code` after unwrapping the ORM's
 * `DrizzleQueryError`, and then requires the constraint name as well, so a duplicate id is
 * not reported as a taken address. These cases pin both halves without a server: the fake
 * runner throws an error shaped as mysql2's `Packet.asError` builds one, and the real
 * Drizzle proxy session wraps it, so the path under test is the production one.
 *
 * They exist because the numeric `errno === 1062` fallback this function used to carry was
 * deleted: mysql2 sets `code` and `errno` in adjacent statements, so no error reaches here
 * with the number and not the name.
 */

function driverError(code: string, errno: number, message: string): Error {
  return Object.assign(new Error(message), {
    code,
    errno,
    sqlState: '23000',
    sqlMessage: message,
  });
}

const duplicateEntry = (key: string): Error =>
  driverError('ER_DUP_ENTRY', 1062, `Duplicate entry 'x' for key '${key}'`);

function fakeRunner(onStatement: () => Promise<unknown>): TenantQueryRunner {
  const respond = (async () => onStatement()) as unknown as TenantQueryRunner['query'];
  return {
    query: respond,
    execute: respond as unknown as TenantQueryRunner['execute'],
    unscoped: () => ({
      query: respond,
      execute: respond as unknown as TenantQueryRunner['execute'],
    }),
  };
}

const organizationId = uuidv7();

const context: TenantContext = createTenantContext({
  organizationId,
  userId: uuidv7(),
  principalKind: 'internal',
  membershipId: uuidv7(),
  capabilities: [],
  policyVersion: 'test',
  correlationId: uuidv7(),
});

const repository = new OrganizationsRepository();

const input = {
  id: organizationId,
  slug: 'lumen-works',
  name: 'Lumen Works',
  defaultLocale: 'en',
  timezone: 'Europe/London',
};

describe('OrganizationsRepository constraint mapping', () => {
  it('reports a taken slug as a slug conflict', async () => {
    const runner = fakeRunner(() =>
      Promise.reject(duplicateEntry('organizations.uq_organizations_slug')),
    );

    await expect(repository.create(runner, context, input)).rejects.toBeInstanceOf(
      OrganizationSlugTakenError,
    );
  });

  it('does not report a colliding id as a taken slug', async () => {
    const runner = fakeRunner(() => Promise.reject(duplicateEntry('organizations.PRIMARY')));

    const thrown: unknown = await repository
      .create(runner, context, input)
      .catch((e: unknown) => e);

    expect(thrown).not.toBeInstanceOf(OrganizationSlugTakenError);
    // The duplicate reached the caller as itself, not translated and not swallowed.
    expect((unwrapQueryError(thrown) as { code?: unknown }).code).toBe('ER_DUP_ENTRY');
  });
});
