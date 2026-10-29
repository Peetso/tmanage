import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeStatement } from './tenant-guard.js';
import {
  CONTENT_PURGE_DAYS_SETTING,
  DEFAULT_CONTENT_PURGE_DAYS,
  contentPurgeDays,
  normaliseDeletedReason,
  parsePurgeDays,
  resetContentPurgeDaysCache,
} from './content-retention.js';
import type { QueryRows, TenantQueryRunner } from './tenant-context.js';

/**
 * platform-admin v2 · PA-03 — every list read of soft-deletable content leaves deleted rows out.
 *
 * Migration 0245 gave every content table `deleted_at` (+ who, why, `purge_after`). A delete now
 * keeps the row, so a list read that forgets `deleted_at IS NULL` would show "deleted" content to
 * members. This is a grep test in the style of `platform-admin.repository.test.ts` and
 * `bound-token-allowlist.test.ts`: {@link LIST_READS} names, per repository file, each method that
 * lists a content table, and each must carry the predicate (`isNull(<table>.deletedAt)` or the
 * `includeDeleted` opt-out that PA-08's trash uses). {@link SINGLE_ROW_OR_SYSTEM} names the reads of
 * the same tables that are deliberately left alone — by-id reads keep returning a deleted row so
 * `authorize()`'s `lifecycle: 'soft_deleted'` refuses writes — so a new list method fails here until
 * it is classified.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULES = resolve(HERE, '../../modules');

/** Drizzle names of the 0245 tables. */
const CONTENT_TABLES = [
  'messages',
  'workItems',
  'directConversations',
  'directMessages',
  'messageAttachments',
  'workItemComments',
  'workItemFiles',
  'documents',
  'documentComments',
  'decisions',
  'decisionComments',
  'meetings',
  'meetingAttachments',
  'requestMessages',
  'requestComments',
  'fileAssets',
  'fileComments',
  'projectUpdateComments',
  'googleDriveAttachments',
  'onedriveAttachments',
] as const;

/** Repository file → the list methods that must exclude soft-deleted rows. */
const LIST_READS: Readonly<Record<string, readonly string[]>> = {
  'conversations/conversations.repository.ts': ['listMessages'],
  'conversations/direct-conversations.repository.ts': ['listForUser', 'listMessages'],
  'conversations/message-attachments.repository.ts': [
    'listForMessages',
    'messageIdsInConversation',
  ],
  'conversations/channel-directory.repository.ts': ['facts'],
  'conversations/message-reactions.repository.ts': ['messageIdsInConversation'],
  'conversations/read-state.repository.ts': ['countMessagesAfter'],
  'conversations/conversation-search.repository.ts': ['searchMessages'],
  'conversations/my-mentions.repository.ts': ['listMentionCandidates'],
  'work/work-items.repository.ts': ['listQuery', 'countOwnedByUser'],
  'work/work-comments.repository.ts': ['listForWorkItem'],
  'work/item-files.repository.ts': ['listForWorkItem', 'findByPair'],
  'docs/documents.repository.ts': ['list'],
  'docs/document-comments.repository.ts': ['list'],
  'docs/document-sharing.repository.ts': ['recent', 'contributors'],
  'decisions/decisions.repository.ts': ['list'],
  'decisions/comments.repository.ts': ['listForDecision'],
  'calendar/meetings.repository.ts': ['list', 'listWindow'],
  'calendar/meeting-agenda.repository.ts': ['listInWindow'],
  'calendar/meeting-client-attendees.repository.ts': ['listForClient'],
  'calendar/meeting-calendar.repository.ts': ['listAttachments'],
  'requests/request-comments.repository.ts': ['listForRequest'],
  'requests/request-messages.repository.ts': [
    'listForRequest',
    'findAttachableFiles',
    'listFilesForRequest',
  ],
  'files/file-assets.repository.ts': [
    'listClientVisibleForDeliverable',
    'listRequestAttachmentsForProject',
  ],
  'files/comments.repository.ts': ['listForFile'],
  'clients/update-comments.repository.ts': ['listForUpdate'],
  'google-drive/google-drive.repository.ts': ['listAttachments'],
  'onedrive/onedrive.repository.ts': ['listAttachments'],
};

/**
 * Reads of the same tables in the same files that are not member-facing lists, with the reason.
 * Keyed `file#method`.
 */
const SINGLE_ROW_OR_SYSTEM: Readonly<Record<string, string>> = {
  'conversations/conversations.repository.ts#findMessageById': 'by id',
  'conversations/conversations.repository.ts#findByClientGeneratedId': 'dedupe probe by key',
  'conversations/conversations.repository.ts#appendMessage': 'write path',
  'conversations/conversations.repository.ts#editMessage': 'write path (refuses deleted rows)',
  'conversations/conversations.repository.ts#moderateMessage': 'the soft delete itself',
  'conversations/direct-conversations.repository.ts#participantDetails':
    'presence (recent activity), not content',
  'conversations/direct-conversations.repository.ts#findPair': 'by key',
  'conversations/direct-conversations.repository.ts#findById': 'by id',
  'conversations/direct-conversations.repository.ts#findByClientGeneratedId': 'dedupe probe',
  'conversations/direct-conversations.repository.ts#appendMessage': 'write path',
  'conversations/message-attachments.repository.ts#findAttachment':
    'by key — the attach revives a detached pair',
  'work/work-items.repository.ts#findById': 'by id',
  'work/work-items.repository.ts#findManyByIds': 'by ids; the service maps lifecycle',
  'work/work-comments.repository.ts#findComment': 'by id',
  'work/item-files.repository.ts#findLink': 'by id',
  'work/item-files.repository.ts#create': 'write path (revives a detached pair)',
  'work/item-files.repository.ts#detachOutsideProject': 'system un-link on a move',
  'docs/documents.repository.ts#findById': 'by id',
  'docs/document-comments.repository.ts#append': 'write path read-back',
  'docs/document-sharing.repository.ts#audiences': 'by ids',
  'decisions/decisions.repository.ts#findById': 'by id',
  'decisions/decisions.repository.ts#create': 'write path read-back',
  'decisions/decisions.repository.ts#findSourceMessage': 'by id (already refuses deleted)',
  'decisions/decisions.repository.ts#findSourceDirectMessage': 'by id',
  'decisions/comments.repository.ts#findComment': 'by id',
  'calendar/meetings.repository.ts#findById': 'by id',
  'requests/request-comments.repository.ts#findComment': 'by id',
  'requests/request-messages.repository.ts#create': 'write path read-back',
  'files/file-assets.repository.ts#findById': 'by id',
  'files/file-assets.repository.ts#listAwaitingVerification': 'upload pipeline (system)',
  'files/file-assets.repository.ts#organizationsAwaitingVerification': 'upload pipeline (system)',
  'files/file-assets.repository.ts#listAwaitingScan': 'scan pipeline (system)',
  'files/file-assets.repository.ts#organizationsAwaitingScan': 'scan pipeline (system)',
  'files/file-assets.repository.ts#organizationsWithPurgeableAssets': 'file purge (system)',
  'files/file-assets.repository.ts#listPurgeable': 'file purge (system)',
  'files/file-assets.repository.ts#findWithLatestVersion': 'by id',
  'files/comments.repository.ts#findOnFile': 'by id',
  'clients/update-comments.repository.ts#findComment': 'by id',
  'google-drive/google-drive.repository.ts#attachedItemsForFile': 'access check by drive file',
  'google-drive/google-drive.repository.ts#insertAttachment': 'write path',
  'google-drive/google-drive.repository.ts#findKnownFolders': 'folder metadata (names only)',
  'google-drive/google-drive.repository.ts#listProjectFolders': 'folder metadata (names only)',
  'onedrive/onedrive.repository.ts#findKnownFolder': 'folder metadata (names only)',
  'onedrive/onedrive.repository.ts#listProjectFolders': 'folder metadata (names only)',
  'onedrive/onedrive.repository.ts#attachedItemsForFile': 'access check by drive item',
  'onedrive/onedrive.repository.ts#insertAttachment': 'write path',
};

const PREDICATE = /isNull\(\s*\w+\.deletedAt\s*\)|deleted_at\s+IS\s+NULL/iu;

/** The method bodies of a class file: `name → text up to the next member at class indent`. */
function methodBodies(source: string): Map<string, string> {
  const lines = source.split('\n');
  const starts: { name: string; index: number }[] = [];
  lines.forEach((line, index) => {
    const match = /^ {2}(?:public |private |protected )?(?:async )?([a-zA-Z_]\w*)\s*[(<]/u.exec(
      line,
    );
    if (match && match[1] !== 'constructor' && !line.trimStart().startsWith('//')) {
      starts.push({ name: match[1] as string, index });
    }
  });
  const bodies = new Map<string, string>();
  starts.forEach((start, n) => {
    const end = n + 1 < starts.length ? (starts[n + 1] as { index: number }).index : lines.length;
    bodies.set(start.name, lines.slice(start.index, end).join('\n'));
  });
  return bodies;
}

function readsContentTable(body: string): boolean {
  return CONTENT_TABLES.some((table) =>
    new RegExp(`\\.(?:from|innerJoin|leftJoin)\\(\\s*${table}\\b`, 'u').test(body),
  );
}

describe('soft-deleted content is excluded from every list read (0245)', () => {
  for (const [file, methods] of Object.entries(LIST_READS)) {
    const source = readFileSync(resolve(MODULES, file), 'utf8');
    const bodies = methodBodies(source);
    for (const method of methods) {
      it(`${file} · ${method} carries deleted_at IS NULL`, () => {
        const body = bodies.get(method);
        expect(body, `${method} not found in ${file}`).toBeDefined();
        expect(body as string).toMatch(PREDICATE);
      });
    }
  }

  it('classifies every other read of a content table in those files', () => {
    const unclassified: string[] = [];
    for (const [file, methods] of Object.entries(LIST_READS)) {
      const bodies = methodBodies(readFileSync(resolve(MODULES, file), 'utf8'));
      for (const [name, body] of bodies) {
        if (methods.includes(name)) continue;
        if (!readsContentTable(body)) continue;
        if (`${file}#${name}` in SINGLE_ROW_OR_SYSTEM) continue;
        unclassified.push(`${file}#${name}`);
      }
    }
    expect(unclassified).toEqual([]);
  });
});

describe('the restore window reader (content-retention.ts)', () => {
  afterEach(() => resetContentPurgeDaysCache());

  function runnerAnswering(value: string | null): TenantQueryRunner & { calls: number } {
    const runner = {
      calls: 0,
      async execute(): Promise<QueryRows> {
        runner.calls += 1;
        return (value === null ? [] : [{ setting_value: value }]) as unknown as QueryRows;
      },
    };
    return runner as unknown as TenantQueryRunner & { calls: number };
  }

  it('defaults to 30 days and reads the platform setting when present', async () => {
    expect(await contentPurgeDays(runnerAnswering(null), 1_000)).toBe(DEFAULT_CONTENT_PURGE_DAYS);
    resetContentPurgeDaysCache();
    expect(await contentPurgeDays(runnerAnswering('7'), 1_000)).toBe(7);
  });

  it('caches for 30 seconds', async () => {
    const runner = runnerAnswering('14');
    await contentPurgeDays(runner, 0);
    await contentPurgeDays(runner, 29_999);
    expect(runner.calls).toBe(1);
    await contentPurgeDays(runner, 30_000);
    expect(runner.calls).toBe(2);
  });

  it('falls back on garbage and clamps to a year', () => {
    expect(parsePurgeDays('abc')).toBe(30);
    expect(parsePurgeDays('0')).toBe(30);
    expect(parsePurgeDays('9999')).toBe(365);
    expect(parsePurgeDays(' 45 ')).toBe(45);
  });

  it('keeps a reason optional, trimmed and capped', () => {
    expect(normaliseDeletedReason(undefined)).toBeNull();
    expect(normaliseDeletedReason('   ')).toBeNull();
    expect(normaliseDeletedReason(' spam ')).toBe('spam');
    expect(normaliseDeletedReason('x'.repeat(600))).toHaveLength(500);
  });

  it('reads a global table the tenant guard admits', () => {
    const analysis = analyzeStatement(
      'SELECT setting_value FROM platform_settings WHERE setting_key = ?',
      [CONTENT_PURGE_DAYS_SETTING],
      '0199aa00-0000-7000-8000-0000000000c1',
    );
    expect(analysis.violations).toEqual([]);
  });
});
