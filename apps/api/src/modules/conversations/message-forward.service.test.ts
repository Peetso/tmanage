import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MessageForwardService } from './message-forward.service.js';

/** R7 slice 4: member check per target, attachment re-link, cap of five. */
const P = 'project-1';
const principal = {
  userId: 'u1',
  organizationId: 'o1',
  kind: 'internal',
  role: 'member',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [P],
  hasOrgWideScope: false,
} as unknown as Principal;
const db = {
  read: async (_c: unknown, w: (r: unknown) => unknown) => w({}),
} as unknown as TenantDatabase;
const source = {
  id: 'm1',
  conversationId: 'c1',
  body: 'hi',
  kind: 'text',
  metaJson: null,
  deletedAt: null,
};
const file = {
  organizationId: 'o1',
  projectId: P,
  status: 'ready',
  audience: 'internal',
  clientOrganizationId: null,
};

function build() {
  const get = vi.fn(async (_c: unknown, _p: unknown, id: string) => {
    if (id === 'stranger') throw new ApiError(404, 'not_found', 'Not found');
    return { id, projectId: id === 'group' ? null : P };
  });
  const postMessage = vi.fn(async (_c: unknown, _p: unknown, id: string) => ({
    message: { id: `new-${id}` },
  }));
  const attach = vi.fn(async () => ({}));
  const list = vi.fn(async () => [{ fileAssetId: 'f1' }]);
  const service = new MessageForwardService(
    db,
    { get, postMessage } as never,
    { list, attach } as never,
    { findMessageById: async () => source } as never,
    { findById: async () => file } as never,
  );
  return { service, postMessage, attach };
}

describe('MessageForwardService', () => {
  it('forwards to member targets, re-links the files and refuses the rest', async () => {
    const { service, postMessage, attach } = build();
    const result = await service.forward({} as TenantContext, principal, 'c1', 'm1', [
      'c2',
      'stranger',
      'group',
    ]);
    expect(result).toEqual({
      forwarded: [{ conversationId: 'c2', messageId: 'new-c2' }],
      refused: ['stranger', 'group'],
    });
    expect(postMessage.mock.calls[0]?.[3]).toEqual({
      body: 'hi',
      kind: 'text',
      meta: { forwardedFromMessageId: 'm1' },
    });
    expect(attach).toHaveBeenCalledWith({}, principal, 'c2', 'new-c2', 'f1');
  });

  it('caps a forward at five conversations', async () => {
    await expect(
      build().service.forward({} as TenantContext, principal, 'c1', 'm1', [
        'a',
        'b',
        'c',
        'd',
        'e',
        'f',
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });
});
