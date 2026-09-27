import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ThreadRepliesController } from './thread-replies.controller.js';
import type {
  AppendThreadReplyCommand,
  ThreadRepliesService,
  ThreadReplyView,
  ThreadView,
} from './thread-replies.service.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext } from '../../common/database/tenant-context.js';

/**
 * x249 thread replies — the HTTP surface over a fake service. The refusal that matters: a POST
 * with an empty (or blank, or non-string) body is a 400 with no append, so an empty reply never
 * reaches the table. The read and the two capability gates are checked alongside it.
 */

const ME = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000d1';
const context = {
  organizationId: 'org',
  userId: ME,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;
const principal = { userId: ME } as unknown as Principal;

const CID = '00000000-0000-7000-8000-00000000c0c0';
const MID = '00000000-0000-7000-8000-00000000a0a0';

/** Records every append so a refusal can be proven to have written nothing. */
class FakeService {
  readonly appended: ThreadReplyView[] = [];

  appendReply(
    _c: TenantContext,
    _p: Principal,
    conversationId: string,
    rootMessageId: string,
    command: AppendThreadReplyCommand,
  ): Promise<ThreadReplyView> {
    const view: ThreadReplyView = {
      id: `reply-${this.appended.length + 1}`,
      conversationId,
      rootMessageId,
      authorMembershipId: MEMBERSHIP,
      body: command.body,
      createdAt: '2026-09-27T00:00:00.000Z',
    };
    this.appended.push(view);
    return Promise.resolve(view);
  }

  listReplies(
    _c: TenantContext,
    _p: Principal,
    _conversationId: string,
    rootMessageId: string,
  ): Promise<ThreadView> {
    return Promise.resolve({
      rootMessageId,
      replies: this.appended,
      count: this.appended.length,
    });
  }
}

function controllerWith(service: FakeService): ThreadRepliesController {
  return new ThreadRepliesController(service as unknown as ThreadRepliesService);
}

async function expectStatus(promise: Promise<unknown>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('ThreadRepliesController (x249)', () => {
  it('appends a reply, then reads the thread back with its count', async () => {
    const service = new FakeService();
    const controller = controllerWith(service);

    const created = await controller.append(context, principal, CID, MID, { body: '  hi  ' });
    expect(created.authorMembershipId).toBe(MEMBERSHIP);
    // Trimmed before it reaches the service.
    expect(created.body).toBe('hi');

    const thread = await controller.list(context, principal, CID, MID);
    expect(thread.count).toBe(1);
    expect(thread.replies).toHaveLength(1);
  });

  it('400s an empty, blank, or non-string body — appending nothing', async () => {
    const service = new FakeService();
    const bad = (body: unknown) =>
      controllerWith(service).append(
        context,
        principal,
        CID,
        MID,
        body as Parameters<ThreadRepliesController['append']>[4],
      );

    await expectStatus(bad({ body: '' }), 400);
    await expectStatus(bad({ body: '   ' }), 400);
    await expectStatus(bad({ body: 42 }), 400);
    await expectStatus(bad({}), 400);
    expect(service.appended).toHaveLength(0);
  });

  it('gates the read with conversation.read and the write with conversation.write', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, ThreadRepliesController.prototype.list)).toBe(
      'conversation.read',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, ThreadRepliesController.prototype.append)).toBe(
      'conversation.write',
    );
  });
});
