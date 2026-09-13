import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { unwrapQueryError } from '../../common/database/query-error.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import {
  UploadSessionKeyTakenError,
  UploadSessionsRepository,
  type CreateUploadSessionInput,
} from './upload-sessions.repository.js';

/**
 * How the idempotency-key unique key becomes {@link UploadSessionKeyTakenError}.
 *
 * The repository reads the driver error's string `code` after unwrapping the ORM's
 * `DrizzleQueryError`. These cases pin that mapping without a server: the fake runner
 * throws an error shaped as mysql2's `Packet.asError` builds one, and the real Drizzle
 * proxy session wraps it, so the path under test is the production one.
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

function fakeRunner(onStatement: () => Promise<unknown>): TenantQueryRunner {
  const respond = (async () => onStatement()) as unknown as TenantQueryRunner['query'];
  const execute = respond as unknown as TenantQueryRunner['execute'];
  return { query: respond, execute, unscoped: () => ({ query: respond, execute }) };
}

const context: TenantContext = createTenantContext({
  organizationId: uuidv7(),
  userId: uuidv7(),
  principalKind: 'internal',
  membershipId: uuidv7(),
  capabilities: [],
  policyVersion: 'test',
  correlationId: uuidv7(),
});

const repository = new UploadSessionsRepository();

const input: CreateUploadSessionInput = {
  id: uuidv7(),
  projectId: uuidv7(),
  clientOrganizationId: null,
  actorUserId: uuidv7(),
  fileAssetId: uuidv7(),
  idempotencyKey: 'idem-1',
  purpose: 'document',
  objectId: null,
  declaredName: 'brief.pdf',
  declaredMimeType: 'application/pdf',
  declaredBytes: 1024,
  declaredContentHash: null,
  partSizeBytes: 1024,
  partCount: 1,
  objectKey: 'o/1',
  providerUploadId: 'p1',
  uploadTargets: [{ partNumber: 1, url: 'https://example.invalid/1' }],
  expiresAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('UploadSessionsRepository constraint mapping', () => {
  it('reports a replayed idempotency key as a key conflict', async () => {
    const runner = fakeRunner(() =>
      Promise.reject(
        driverError(
          'ER_DUP_ENTRY',
          1062,
          "Duplicate entry 'x' for key 'upload_sessions.uq_upload_sessions_idempotency'",
        ),
      ),
    );

    await expect(repository.create(runner, context, input)).rejects.toBeInstanceOf(
      UploadSessionKeyTakenError,
    );
  });

  it('lets an unrelated driver failure through untranslated', async () => {
    const runner = fakeRunner(() =>
      Promise.reject(
        driverError('ER_LOCK_DEADLOCK', 1213, 'Deadlock found when trying to get lock'),
      ),
    );

    const thrown: unknown = await repository
      .create(runner, context, input)
      .catch((e: unknown) => e);

    expect(thrown).not.toBeInstanceOf(UploadSessionKeyTakenError);
    expect((unwrapQueryError(thrown) as { code?: unknown }).code).toBe('ER_LOCK_DEADLOCK');
  });
});
