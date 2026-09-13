import { describe, expect, it } from 'vitest';
import { uuidv7 } from '@tmanage/domain';
import { unwrapQueryError } from '../../common/database/query-error.js';
import { createTenantContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import {
  ConversationNameTakenError,
  ConversationsRepository,
  DuplicateMessageError,
  InvalidThreadParentError,
  MessageAlreadyConvertedError,
} from './conversations.repository.js';

/**
 * How a constraint violation becomes a domain error.
 *
 * The repository reads the driver error's string `code` — `ER_DUP_ENTRY`,
 * `ER_NO_REFERENCED_ROW_2` — after unwrapping the ORM's `DrizzleQueryError`. These cases
 * pin that mapping without a server: the fake runner throws an error shaped exactly as
 * mysql2's `Packet.asError` builds one (`code`, `errno`, `sqlState` and `sqlMessage`, in
 * that constructor's own order), and the real Drizzle proxy session wraps it on the way
 * out, so the unwrap-then-match path under test is the production one.
 *
 * They exist because the numeric `errno` fallback these functions used to carry was
 * deleted: every driver error that names 1062 or 1452 also names the string, so the
 * fallback could not run. What it was written to protect is asserted here instead.
 */

/** A driver error as mysql2 builds one — `code` and `errno` always set together. */
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

const foreignKeyFailure = (constraint: string): Error =>
  driverError(
    'ER_NO_REFERENCED_ROW_2',
    1452,
    `Cannot add or update a child row: a foreign key constraint fails (\`${constraint}\`)`,
  );

/** An unrelated driver failure: neither branch may claim it. */
const deadlock = (): Error =>
  driverError('ER_LOCK_DEADLOCK', 1213, 'Deadlock found when trying to get lock');

type Responder = (statement: string) => Promise<unknown>;

/**
 * A runner whose statements are answered by two callbacks: `query` is the seam Drizzle
 * uses, `execute` the one the repository's own SQL goes through.
 */
function fakeRunner(onQuery: Responder, onExecute?: Responder): TenantQueryRunner {
  const query = (async (statement: string) =>
    onQuery(statement)) as unknown as TenantQueryRunner['query'];
  const execute = (async (statement: string) =>
    (onExecute ?? onQuery)(statement)) as unknown as TenantQueryRunner['execute'];
  return { query, execute, unscoped: () => ({ query, execute }) };
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

const repository = new ConversationsRepository();

describe('ConversationsRepository constraint mapping', () => {
  it('reports a duplicate channel name as a conflict rather than a driver error', async () => {
    const runner = fakeRunner(() =>
      Promise.reject(duplicateEntry('conversations.uq_conversations_project_name')),
    );

    await expect(
      repository.create(runner, context, {
        projectId: uuidv7(),
        name: 'general',
        createdByUserId: uuidv7(),
      }),
    ).rejects.toBeInstanceOf(ConversationNameTakenError);
  });

  it('reports a duplicate name on rename as the same conflict', async () => {
    const runner = fakeRunner(() =>
      Promise.reject(duplicateEntry('conversations.uq_conversations_project_name')),
    );

    await expect(repository.rename(runner, context, uuidv7(), 1, 'general')).rejects.toBeInstanceOf(
      ConversationNameTakenError,
    );
  });

  it('lets an unrelated driver failure through untranslated', async () => {
    const runner = fakeRunner(() => Promise.reject(deadlock()));

    const thrown: unknown = await repository
      .create(runner, context, {
        projectId: uuidv7(),
        name: 'general',
        createdByUserId: uuidv7(),
      })
      .catch((e: unknown) => e);

    expect(thrown).not.toBeInstanceOf(ConversationNameTakenError);
    expect((unwrapQueryError(thrown) as { code?: unknown }).code).toBe('ER_LOCK_DEADLOCK');
  });

  it('reports a refused thread parent as an invalid parent', async () => {
    const parentMessageId = uuidv7();
    const runner = fakeRunner(
      () => Promise.reject(foreignKeyFailure('fk_messages_parent_is_root')),
      () => Promise.resolve([{ next_sequence_no: 1 }]),
    );

    await expect(
      repository.appendMessage(runner, context, {
        conversationId: uuidv7(),
        authorUserId: uuidv7(),
        body: 'hello',
        parentMessageId,
      }),
    ).rejects.toBeInstanceOf(InvalidThreadParentError);
  });

  it('reports a replayed client-generated id as a duplicate message', async () => {
    const runner = fakeRunner(
      () => Promise.reject(duplicateEntry('messages.uq_messages_client_generated')),
      () => Promise.resolve([{ next_sequence_no: 1 }]),
    );

    await expect(
      repository.appendMessage(runner, context, {
        conversationId: uuidv7(),
        authorUserId: uuidv7(),
        body: 'hello',
        clientGeneratedId: uuidv7(),
      }),
    ).rejects.toBeInstanceOf(DuplicateMessageError);
  });

  it('reports a second work link on one message as already converted', async () => {
    const runner = fakeRunner(() =>
      Promise.reject(duplicateEntry('message_work_links.uq_message_work_links_message')),
    );

    await expect(
      repository.createWorkLink(runner, context, uuidv7(), uuidv7(), uuidv7()),
    ).rejects.toBeInstanceOf(MessageAlreadyConvertedError);
  });
});
