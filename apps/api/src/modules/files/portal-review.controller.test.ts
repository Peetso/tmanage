import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  PortalFileReviewController,
  PortalReviewMentionCandidatesController,
  PortalReviewThreadsController,
} from './portal-review.controller.js';
import type { ReviewService } from './review.service.js';

/**
 * R4 slice 8 — the portal twins only route; the rules are {@link ReviewService}'s (its own suite
 * proves a client reads only client-visible threads, writes only client-visible ones and resolves
 * only its own). What this pins: every portal route enters through the **client** door — never the
 * studio's — and the client's mention search always asks for the client-visible list.
 */

const context = {} as TenantContext;
const principal = { kind: 'client' } as unknown as Principal;

function recordingService(): { service: ReviewService; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args.slice(2)]);
      return Promise.resolve({});
    };
  const service = {
    listThreads: record('listThreads'),
    createThread: record('createThread'),
    addComment: record('addComment'),
    setResolved: record('setResolved'),
    moveThread: record('moveThread'),
    editComment: record('editComment'),
    deleteComment: record('deleteComment'),
    mentionCandidates: record('mentionCandidates'),
  } as unknown as ReviewService;
  return { service, calls };
}

describe('portal review routes (R4 slice 8)', () => {
  it('enter every review action through the client door', async () => {
    const { service, calls } = recordingService();
    const files = new PortalFileReviewController(service);
    const threads = new PortalReviewThreadsController(service);
    const people = new PortalReviewMentionCandidatesController(service);

    await files.list(context, principal, 'file-1', 'open');
    await files.create(context, principal, 'file-1', { body: 'Bigger logo' });
    await threads.reply(context, principal, 'thread-1', { body: 'Thanks' });
    await threads.resolve(context, principal, 'thread-1');
    await threads.unresolve(context, principal, 'thread-1');
    await threads.move(context, principal, 'thread-1', { anchor: { x: 0.1, y: 0.2 } });
    await threads.edit(context, principal, 'comment-1', { body: 'Edited' });
    await threads.remove(context, principal, 'comment-1');
    await people.search(context, principal, 'project-1', 'om', '5');

    expect(calls).toEqual([
      ['listThreads', 'client', 'file-1', { status: 'open' }],
      ['createThread', 'client', 'file-1', { body: 'Bigger logo' }],
      ['addComment', 'client', 'thread-1', { body: 'Thanks' }],
      ['setResolved', 'client', 'thread-1', true],
      ['setResolved', 'client', 'thread-1', false],
      ['moveThread', 'client', 'thread-1', { anchor: { x: 0.1, y: 0.2 } }],
      ['editComment', 'client', 'comment-1', { body: 'Edited' }],
      ['deleteComment', 'client', 'comment-1'],
      [
        'mentionCandidates',
        'client',
        'project-1',
        { q: 'om', audience: 'client_visible', limit: '5' },
      ],
    ]);
  });

  it('a client list never names a version: the service reads the one the client opened', async () => {
    const { service, calls } = recordingService();
    await new PortalFileReviewController(service).list(context, principal, 'file-1');
    expect(calls[0]?.[3]).toEqual({ status: undefined });
  });

  it('refuses a missing id with a 400 before the service is asked', async () => {
    const { service, calls } = recordingService();
    await expect(
      new PortalReviewThreadsController(service).reply(context, principal, '', { body: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
  });
});
