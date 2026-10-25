import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  MAX_ATTACHMENT_BATCH_MESSAGE_IDS,
  MessageAttachmentsController,
} from './message-attachments.controller.js';
import { MessageAttachmentsService } from './message-attachments.service.js';
import type { ConversationsRepository } from './conversations.repository.js';
import type {
  AttachedFileRow,
  MessageAttachmentsRepository,
} from './message-attachments.repository.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import type { ConversationRow, FileVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * L2 — the batched attachments read (`GET …/conversations/:id/attachments?messageIds=`) and the
 * scan status each attachment carries. Database-free: the gate runs once per conversation, ids
 * from another channel are dropped, the cap is one channel page, and the scan status follows the
 * download door's own rules under the owner's "downloads before a virus scan" policy.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-00000000-0000-0000-0000-00000000001';
const CONVERSATION = 'conversation-0000-0000-0000-00000000001';

const context = { organizationId: ORG, membershipId: 'm1' } as unknown as TenantContext;

const MEMBER: Principal = {
  userId: 'user-0000-0000-0000-0000-000000000001',
  organizationId: ORG,
  kind: 'internal',
  role: 'member',
  membershipId: 'm1',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT],
  hasOrgWideScope: false,
};

const conversation = {
  id: CONVERSATION,
  organizationId: ORG,
  projectId: PROJECT,
  archivedAt: null,
} as unknown as ConversationRow;

const database = {
  read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
} as unknown as TenantDatabase;

function version(facts: Partial<FileVersionRow>): FileVersionRow {
  return {
    sizeBytes: 2048,
    detectedMimeType: 'application/pdf',
    scanVerdict: 'clean',
    trustZone: 'private',
    ...facts,
  } as unknown as FileVersionRow;
}

function row(
  messageId: string,
  fileAssetId: string,
  latest: FileVersionRow | null,
): AttachedFileRow {
  return {
    attachmentId: `a-${fileAssetId}`,
    messageId,
    fileAssetId,
    name: `${fileAssetId}.pdf`,
    sizeBytes: latest === null ? null : 2048,
    attachedAt: new Date('2026-10-25T10:00:00.000Z'),
    assetStatus: 'ready',
    latestVersion: latest,
  };
}

function serviceWith(options: {
  readonly rows?: readonly AttachedFileRow[];
  readonly inConversation?: readonly string[];
  readonly conversations?: Partial<ConversationsRepository>;
  readonly policy?: 'allow_labeled' | 'block';
  readonly scanner?: ScannerPresence;
}) {
  const listForMessages = vi.fn(async () => options.rows ?? []);
  const messageIdsInConversation = vi.fn(async () => options.inConversation ?? []);
  const findByKey = vi.fn(async () =>
    options.policy === undefined ? undefined : { settingValue: options.policy },
  );
  const service = new MessageAttachmentsService(
    database,
    { listForMessages, messageIdsInConversation } as unknown as MessageAttachmentsRepository,
    (options.conversations ?? {
      findById: async () => conversation,
      findMembership: async () => ({}) as never,
    }) as ConversationsRepository,
    {} as FileAssetsRepository,
    options.scanner,
    { findByKey } as unknown as OrgSettingsRepository,
  );
  return { service, listForMessages, messageIdsInConversation, findByKey };
}

describe('L2 batched attachments route', () => {
  it('is gated on conversation.read', () => {
    expect(
      new Reflector().get(REQUIRED_CAPABILITY, MessageAttachmentsController.prototype.listMany),
    ).toBe('conversation.read');
  });

  it('is capped at one channel page of message ids', () => {
    expect(MAX_ATTACHMENT_BATCH_MESSAGE_IDS).toBe(200);
  });

  it('refuses an empty, oversized or malformed id list with 400 and never reads', async () => {
    const listMany = vi.fn();
    const controller = new MessageAttachmentsController({
      listMany,
    } as unknown as MessageAttachmentsService);
    const tooMany = Array.from({ length: 201 }, (_v, i) => `m${i}`).join(',');
    for (const query of [undefined, '', ' , ', tooMany, 'x'.repeat(37), ['a', 'b']]) {
      await expect(controller.listMany(context, MEMBER, CONVERSATION, query)).rejects.toMatchObject(
        { status: 400 },
      );
    }
    expect(listMany).not.toHaveBeenCalled();
  });

  it('answers { messages } in the order asked, for at most a page', async () => {
    const listMany = vi.fn(async () => [{ messageId: 'm2', attachments: [] }]);
    const controller = new MessageAttachmentsController({
      listMany,
    } as unknown as MessageAttachmentsService);
    const ids = Array.from({ length: 200 }, (_v, i) => `m${i}`);
    await expect(
      controller.listMany(context, MEMBER, CONVERSATION, ` ${ids.join(' , ')} `),
    ).resolves.toEqual({ messages: [{ messageId: 'm2', attachments: [] }] });
    expect(listMany).toHaveBeenCalledWith(context, MEMBER, CONVERSATION, ids);
  });
});

describe('MessageAttachmentsService.listMany', () => {
  it('answers 404 for an unknown conversation and reads no attachment', async () => {
    const { service, listForMessages } = serviceWith({
      conversations: { findById: async () => null },
    });
    await expect(service.listMany(context, MEMBER, CONVERSATION, ['m1'])).rejects.toMatchObject({
      status: 404,
    });
    expect(listForMessages).not.toHaveBeenCalled();
  });

  it('answers 404 for a caller who is not a member of the channel', async () => {
    const { service, listForMessages } = serviceWith({
      conversations: { findById: async () => conversation, findMembership: async () => null },
    });
    await expect(service.listMany(context, MEMBER, CONVERSATION, ['m1'])).rejects.toMatchObject({
      status: 404,
    });
    expect(listForMessages).not.toHaveBeenCalled();
  });

  it('drops ids from another channel and groups the rest by message', async () => {
    const { service, listForMessages } = serviceWith({
      inConversation: ['m1', 'm2'],
      rows: [row('m2', 'f2', version({})), row('m1', 'f1', version({}))],
    });
    const result = await service.listMany(context, MEMBER, CONVERSATION, [
      'm1',
      'foreign',
      'm2',
      'm1',
    ]);
    expect(listForMessages).toHaveBeenCalledWith({}, context, ['m1', 'm2']);
    expect(result.map((entry) => entry.messageId)).toEqual(['m1', 'm2']);
    expect(result[0]?.attachments.map((a) => a.fileAssetId)).toEqual(['f1']);
    expect(result[1]?.attachments.map((a) => a.fileAssetId)).toEqual(['f2']);
  });

  it('marks a clean file clean and reads no policy', async () => {
    const { service, findByKey } = serviceWith({
      inConversation: ['m1'],
      rows: [row('m1', 'f1', version({}))],
    });
    const [entry] = await service.listMany(context, MEMBER, CONVERSATION, ['m1']);
    expect(entry?.attachments[0]).toMatchObject({ scanStatus: 'clean', sizeBytes: 2048 });
    expect(findByKey).not.toHaveBeenCalled();
  });

  it('marks an unscanned file not_scanned under "Allow, marked Not scanned"', async () => {
    const { service } = serviceWith({
      inConversation: ['m1'],
      rows: [row('m1', 'f1', version({ scanVerdict: 'unscanned', trustZone: 'quarantine' }))],
      policy: 'allow_labeled',
      scanner: { kind: 'engine' },
    });
    const [entry] = await service.listMany(context, MEMBER, CONVERSATION, ['m1']);
    expect(entry?.attachments[0]?.scanStatus).toBe('not_scanned');
  });

  it('marks an unscanned file being_checked under "Block until scanned", policy read once', async () => {
    const { service, findByKey } = serviceWith({
      inConversation: ['m1'],
      rows: [
        row('m1', 'f1', version({ scanVerdict: null })),
        row('m1', 'f2', version({ scanVerdict: 'unscanned' })),
      ],
      policy: 'block',
      scanner: { kind: 'engine' },
    });
    const [entry] = await service.listMany(context, MEMBER, CONVERSATION, ['m1']);
    expect(entry?.attachments.map((a) => a.scanStatus)).toEqual(['being_checked', 'being_checked']);
    expect(findByKey).toHaveBeenCalledTimes(1);
  });

  it('treats a stored block as allow without a scanner, as the download door does', async () => {
    const { service } = serviceWith({
      inConversation: ['m1'],
      rows: [row('m1', 'f1', version({ scanVerdict: 'unscanned' }))],
      policy: 'block',
    });
    const [entry] = await service.listMany(context, MEMBER, CONVERSATION, ['m1']);
    expect(entry?.attachments[0]?.scanStatus).toBe('not_scanned');
  });

  it('marks an infected or version-less file unavailable', async () => {
    const { service } = serviceWith({
      inConversation: ['m1'],
      rows: [row('m1', 'f1', version({ scanVerdict: 'infected' })), row('m1', 'f2', null)],
    });
    const [entry] = await service.listMany(context, MEMBER, CONVERSATION, ['m1']);
    expect(entry?.attachments.map((a) => a.scanStatus)).toEqual(['unavailable', 'unavailable']);
  });
});
