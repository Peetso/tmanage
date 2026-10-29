import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantDatabase } from '../../../common/database/tenant-context.js';
import { ApiError } from '../../../common/http/errors.js';
import type { PlatformAdminActor } from '../platform-admin.guard.js';
import { PLATFORM_PERMISSION_METADATA } from '../require-platform-permission.decorator.js';
import { PlatformCommentsContentController } from './comments-content.controller.js';
import type { ContentListsRepository, ContentRecord } from './content-lists.repository.js';
import {
  APPEND_ONLY_MESSAGE,
  PlatformContentService,
  VERSION_LOCKED_MESSAGE,
  openInAppPath,
} from './content.service.js';
import type { ContentOrgPorts } from './content.service.js';
import { PlatformConversationsContentController } from './conversations-content.controller.js';
import { PlatformDecisionsContentController } from './decisions-content.controller.js';
import { PlatformDocsContentController } from './docs-content.controller.js';
import { PlatformFilesContentController } from './files-content.controller.js';
import { PlatformMeetingsContentController } from './meetings-content.controller.js';
import { PlatformRequestsContentController } from './requests-content.controller.js';
import { supportSessionRequired } from './support-context.js';
import type { SupportScope } from './support-context.js';
import { PlatformTrashController } from './trash.controller.js';
import { PlatformWorkContentController } from './work-content.controller.js';

const ORG = '0199aa00-0000-7000-8000-00000000a001';
const ITEM = '0199aa00-0000-7000-8000-00000000b001';
const SESSION = '0199aa00-0000-7000-8000-00000000c001';
const ADMIN = 'admin-user';

const actor: PlatformAdminActor = {
  account: {
    userId: ADMIN,
    email: 'peter@peetrix.com',
    displayName: 'Peter',
    emailVerified: true,
    mfaEnabled: true,
  },
  sessionId: 'browser-1',
  stepUp: { expiresAt: new Date(Date.now() + 600_000), mfaVerified: true },
  permissions: ['platform.content.view', 'platform.content.moderate'],
};

const context = {
  organizationId: ORG,
  userId: ADMIN,
  principalKind: 'internal',
  membershipId: 'hidden',
  capabilities: [],
  policyVersion: 'v2:1:1',
  correlationId: 'corr-1',
} as unknown as TenantContext;

const scope: SupportScope = {
  organizationId: ORG,
  context,
  principal: { userId: ADMIN } as never,
  session: { id: SESSION, adminUserId: ADMIN, expiresAt: new Date(Date.now() + 3_600_000) },
};

const REQUEST = { correlationId: 'corr-1', request: { headers: {} } };

function record(
  overrides: Partial<ContentRecord> & { body?: string | null; version?: number | null } = {},
) {
  return {
    kind: 'message',
    id: ITEM,
    parentId: 'conv-1',
    title: 'Here is the shared drive password',
    preview: null,
    projectId: 'project-1',
    projectName: 'Spring launch',
    authorUserId: 'author-1',
    authorName: 'Youssef Nabil',
    createdAt: new Date('2026-10-27T10:00:00Z'),
    updatedAt: new Date('2026-10-27T10:00:00Z'),
    deletedAt: null,
    deletedByUserId: null,
    deletedReason: null,
    purgeAfter: null,
    state: null,
    audience: null,
    location: null,
    sizeBytes: null,
    versions: null,
    edited: false,
    replies: null,
    dueAt: null,
    sequenceNo: 3,
    body: 'Here is the shared drive password',
    version: 4,
    ...overrides,
  } as ContentRecord & { body: string | null; version: number | null };
}

function setup(options: { found?: ReturnType<typeof record>; supportFails?: boolean } = {}) {
  const runner = { query: vi.fn(async () => [{ id: ORG, name: 'Northstar', slug: 'northstar' }]) };
  const database = {
    read: vi.fn(async (_ctx: unknown, work: (r: unknown) => Promise<unknown>) => work(runner)),
    transaction: vi.fn(async (_ctx: unknown, work: (r: unknown) => Promise<unknown>) =>
      work(runner),
    ),
  };
  const support = {
    resolve: vi.fn(async () => {
      if (options.supportFails) throw supportSessionRequired('no_live_support_session');
      return scope;
    }),
  };
  let current = options.found ?? record();
  const lists = {
    organization: vi.fn(async () => ({ id: ORG, name: 'Northstar', slug: 'northstar' })),
    findOne: vi.fn(async () => current),
    softDelete: vi.fn(async () => {
      current = { ...current, deletedAt: new Date(), deletedReason: 'r' };
      return true;
    }),
    restore: vi.fn(async () => {
      current = { ...current, deletedAt: null, deletedReason: null };
      return true;
    }),
    deletedBySupport: vi.fn(async () => new Set<string>()),
    history: vi.fn(async () => []),
    deliverableVersions: vi.fn(async () => [] as unknown[]),
    listChannels: vi.fn(async () => []),
    counts: vi.fn(),
    trash: vi.fn(async () => []),
  };
  const audit = { record: vi.fn(async () => ({})), recordStandalone: vi.fn(async () => ({})) };
  const platformAudit = { record: vi.fn(async () => ({})) };
  const org = {
    messages: { editMessage: vi.fn(async () => ({})), moderateMessage: vi.fn(async () => ({})) },
    workItemsRepository: { softDelete: vi.fn(async () => ({})) },
    workItems: {
      update: vi.fn(async () => ({ version: 5 })),
      transition: vi.fn(async () => ({})),
    },
    documents: { rename: vi.fn(async () => ({})) },
    decisions: { updateDetails: vi.fn(async () => ({})) },
    meetings: { update: vi.fn(async () => ({})) },
    downloads: { download: vi.fn() },
  };
  const service = new PlatformContentService(
    database as unknown as TenantDatabase,
    support,
    lists as unknown as ContentListsRepository,
    audit as never,
    platformAudit as never,
    org as unknown as ContentOrgPorts,
  );
  return { service, lists, audit, platformAudit, org, database, support };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('PlatformContentService (PA-08)', () => {
  it('a read without a live Support session is refused 428 before any query — reads are access', async () => {
    const { service, lists } = setup({ supportFails: true });
    const error = await refusal(service.list(actor, ORG, 'chats', {}, REQUEST));
    expect(error.status).toBe(428);
    expect(error.code).toBe('support_session_required');
    expect(lists.listChannels).not.toHaveBeenCalled();
  });

  it('edits a message through the conversations repository, with before/after in the org audit', async () => {
    const { service, org, audit, platformAudit } = setup();
    await service.edit(actor, ORG, 'message', ITEM, { body: 'Use the vault link' }, REQUEST);
    expect(org.messages.editMessage).toHaveBeenCalledWith(
      expect.anything(),
      context,
      ITEM,
      'Use the vault link',
      null,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({
        action: 'message.edited',
        objectId: ITEM,
        changes: [
          {
            field: 'body',
            before: 'Here is the shared drive password',
            after: 'Use the vault link',
          },
        ],
      }),
    );
    expect(platformAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'platform.content_edited',
        supportSessionId: SESSION,
        reasonRequired: false,
      }),
    );
  });

  it('edits a work item through the work service (update, then the state transition)', async () => {
    const { service, org, audit } = setup({
      found: record({ kind: 'work_item', title: 'Spring launch brief', state: 'internal_review' }),
    });
    await service.edit(
      actor,
      ORG,
      'work_item',
      ITEM,
      { title: 'Spring launch brief — 20s hero cut', state: 'in_progress' },
      REQUEST,
    );
    expect(org.workItems.update).toHaveBeenCalledWith(context, scope.principal, ITEM, 4, {
      title: 'Spring launch brief — 20s hero cut',
    });
    expect(org.workItems.transition).toHaveBeenCalledWith(
      context,
      scope.principal,
      ITEM,
      5,
      'in_progress',
    );
    expect(audit.recordStandalone).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        action: 'work_item.updated',
        changes: [
          {
            field: 'title',
            before: 'Spring launch brief',
            after: 'Spring launch brief — 20s hero cut',
          },
          { field: 'state', before: 'internal_review', after: 'in_progress' },
        ],
      }),
    );
  });

  it('refuses to rewrite an append-only comment and explains why', async () => {
    const { service, audit } = setup({ found: record({ kind: 'work_comment' }) });
    const error = await refusal(
      service.edit(actor, ORG, 'work_comment', ITEM, { body: 'x' }, REQUEST),
    );
    expect(error.status).toBe(409);
    expect(error.message).toBe(APPEND_ONLY_MESSAGE);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('a delete without a reason is a 400 and changes nothing', async () => {
    const { service, lists, support } = setup();
    const error = await refusal(service.remove(actor, ORG, 'doc', ITEM, {}, REQUEST));
    expect(error.status).toBe(400);
    expect(support.resolve).not.toHaveBeenCalled();
    expect(lists.softDelete).not.toHaveBeenCalled();
  });

  it('a delete sets deleted_* with the reason and records the delete action', async () => {
    const { service, lists, audit, platformAudit } = setup({ found: record({ kind: 'doc' }) });
    const result = await service.remove(
      actor,
      ORG,
      'doc',
      ITEM,
      { reason: 'Password posted with a client guest' },
      REQUEST,
    );
    expect(lists.softDelete).toHaveBeenCalledWith(
      expect.anything(),
      context,
      'doc',
      ITEM,
      'Password posted with a client guest',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({
        action: 'document.deleted',
        changes: expect.arrayContaining([
          { field: 'deleted_reason', before: null, after: 'Password posted with a client guest' },
        ]),
      }),
    );
    expect(platformAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.content_deleted', reasonRequired: true }),
    );
    expect(result.item.deletedAt).not.toBeNull();
  });

  it('a message delete goes through the conversations repository with the reason', async () => {
    const { service, org } = setup();
    await service.remove(actor, ORG, 'message', ITEM, { reason: 'Password in chat' }, REQUEST);
    expect(org.messages.moderateMessage).toHaveBeenCalledWith(
      expect.anything(),
      context,
      ITEM,
      ADMIN,
      'Password in chat',
    );
  });

  it('restore clears deleted_* and records <kind>.restored', async () => {
    const { service, lists, audit } = setup({
      found: record({ kind: 'meeting', deletedAt: new Date(), deletedReason: 'dup' }),
    });
    const result = await service.restore(actor, ORG, 'meeting', ITEM, {}, REQUEST);
    expect(lists.restore).toHaveBeenCalledWith(expect.anything(), context, 'meeting', ITEM);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      context,
      expect.objectContaining({ action: 'meeting.restored' }),
    );
    expect(result.item.deletedAt).toBeNull();
  });

  it('an approved deliverable version is locked: delete refused with the explanation, recorded', async () => {
    const { service, lists, platformAudit } = setup({ found: record({ kind: 'file' }) });
    lists.deliverableVersions.mockResolvedValue([
      {
        id: 'v3',
        deliverableId: 'd1',
        deliverableTitle: 'Logo',
        versionNo: 3,
        fileAssetId: ITEM,
        fileName: 'logo-v3.png',
        createdAt: new Date(),
        approvalState: 'approved',
        approvedAt: new Date(),
        approvedByName: 'Lina Haddad',
      },
    ]);
    const error = await refusal(
      service.remove(actor, ORG, 'file', ITEM, { reason: 'Remove the old logo' }, REQUEST),
    );
    expect(error.status).toBe(409);
    expect(error.message).toBe(VERSION_LOCKED_MESSAGE);
    expect(error.auditCode).toBe('version_locked');
    expect(lists.softDelete).not.toHaveBeenCalled();
    expect(platformAudit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.content_edit_refused' }),
    );
  });

  it('the viewer of a locked file shows the lock and no editable field', async () => {
    const { service, lists } = setup({ found: record({ kind: 'file', state: 'ready' }) });
    lists.deliverableVersions.mockResolvedValue([
      {
        id: 'v3',
        deliverableId: 'd1',
        deliverableTitle: 'Logo',
        versionNo: 3,
        fileAssetId: ITEM,
        fileName: 'logo-v3.png',
        createdAt: new Date(),
        approvalState: 'approved',
        approvedAt: new Date('2026-10-22T14:05:00Z'),
        approvedByName: 'Lina Haddad',
      },
    ]);
    const view = await service.item(actor, ORG, 'file', ITEM, REQUEST);
    expect(view.locked).toEqual({
      code: 'version_locked',
      approvedAt: '2026-10-22T14:05:00.000Z',
      approvedByName: 'Lina Haddad',
    });
    expect(view.editable).toEqual([]);
    expect(view.item.scan).toBe('clean');
    expect(view.openInApp).toBe('/northstar/projects/project-1');
  });

  it('builds Open in app paths inside the organization', () => {
    expect(openInAppPath('northstar', record())).toBe('/northstar/chat/conv-1');
    expect(openInAppPath('northstar', record({ kind: 'work_item' }))).toBe(
      `/northstar/work/${ITEM}`,
    );
  });
});

describe('content routes need platform.content.view to read and .moderate to change', () => {
  const controllers = [
    PlatformConversationsContentController,
    PlatformWorkContentController,
    PlatformCommentsContentController,
    PlatformDocsContentController,
    PlatformDecisionsContentController,
    PlatformMeetingsContentController,
    PlatformFilesContentController,
    PlatformRequestsContentController,
    PlatformTrashController,
  ];
  it.each(controllers.map((c) => [c.name, c] as const))('%s', (_name, controller) => {
    const proto = controller.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter((name) => name !== 'constructor');
    expect(handlers.length).toBeGreaterThan(0);
    for (const name of handlers) {
      const handler = proto[name] as object;
      const method = Reflect.getMetadata('method', handler) as number;
      const permission = Reflect.getMetadata(PLATFORM_PERMISSION_METADATA, handler) as string;
      // RequestMethod.GET is 0.
      expect(permission, `${controller.name}.${name}`).toBe(
        method === 0 ? 'platform.content.view' : 'platform.content.moderate',
      );
    }
  });
});
