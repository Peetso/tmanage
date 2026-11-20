import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { FileAssetRow } from '../../common/database/schema.js';
import type { NotificationsRepository } from '../inbox/notifications.repository.js';

/**
 * QA-FIX S5 (2026-11-20). The uploader is told when a file of theirs is blocked: refused by the
 * safety check (`file-verifier.ts`), by the virus scan (`file-scanner.ts`), or later by a re-check
 * with newer signatures (`file-rescanner.ts`). Before this, `file.rejected.v1` was appended for an
 * "inbox/notification" consumer that was never built, so a blocked file simply vanished.
 *
 * One in-app notification per asset, written in the same transaction as the move to `rejected`
 * (AS-1: the state change and its effect commit together). The dedupe key is the asset alone, with
 * no timestamp (AS-2), so a redelivered pass or two overlapping instances write it once.
 */
export const FILE_BLOCKED_NOTIFICATION = 'file.blocked.v1';

export function fileBlockedDedupeKey(fileAssetId: string): string {
  return `${FILE_BLOCKED_NOTIFICATION}:${fileAssetId}`;
}

export class FileBlockNotifier {
  constructor(
    private readonly notifications: Pick<NotificationsRepository, 'insertForRecipient'>,
  ) {}

  async blocked(tx: TenantQueryRunner, context: TenantContext, asset: FileAssetRow): Promise<void> {
    await this.notifications.insertForRecipient(tx, context, {
      recipientUserId: asset.ownerUserId,
      type: FILE_BLOCKED_NOTIFICATION,
      objectType: 'file_asset',
      objectId: asset.id,
      dedupeKey: fileBlockedDedupeKey(asset.id),
    });
  }
}
