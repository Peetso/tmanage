import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { analyzeStatement } from '../../common/database/tenant-guard.js';
import { ChatListController } from './chat-list.controller.js';
import { chatListParams, chatListSql, ChatListRepository } from './chat-list.repository.js';
import type { ChatListDbRow } from './chat-list.repository.js';
import { ChatListService } from './chat-list.service.js';

const context = { organizationId: 'org', userId: 'me', membershipId: 'ms' } as TenantContext;
const principal = { hasOrgWideScope: false } as Principal;
const dm: ChatListDbRow = {
  conversation_id: 'c1',
  kind: 'direct',
  name: 'dm:c1',
  project_id: null,
  photo_file_asset_id: null,
  direct_user_low_id: 'me',
  direct_user_high_id: 'sara',
  last_message_at: '2026-11-01T10:00:00Z',
  created_at: '2026-11-01T09:00:00Z',
  pinned_at: null,
  archived_at: null,
  last_kind: 'text',
  last_body: 'hello',
  last_deleted_at: null,
  last_created_at: '2026-11-01T10:00:00Z',
  last_author_user_id: 'sara',
  last_author_name: 'Sara',
  other_display_name: 'Sara Ali',
  muted: 1,
  unread_count: '2',
};

describe('chat list (R7 slice 2)', () => {
  it('counts unread after the read marker and sorts pinned first, then last message', () => {
    const sql = chatListSql({ includeArchived: false, hasOrgWideScope: false });
    expect(sql).toMatch(/um\.sequence_no > COALESCE\(rm\.sequence_no, 0\)/);
    expect(sql).toMatch(
      /ORDER BY \(cm\.pinned_at IS NULL\), cm\.pinned_at DESC,\s+\(c\.last_message_at IS NULL\), c\.last_message_at DESC/,
    );
    expect(sql).toContain('AND cm.archived_at IS NULL');
    const one = { includeArchived: true, hasOrgWideScope: true, conversationId: 'c1' };
    expect(chatListSql(one).split('?').length - 1).toBe(chatListParams(context, one).length);
  });

  it('passes the tenant guard for the list and the one-conversation read (A1 live 500)', () => {
    const live = { organizationId: 'org-1', userId: 'u-1', membershipId: 'm-1' } as TenantContext;
    for (const query of [
      { includeArchived: false, hasOrgWideScope: false },
      { includeArchived: true, hasOrgWideScope: true, conversationId: 'c1', limit: 1 },
    ]) {
      const sql = chatListSql(query);
      expect(sql).not.toMatch(/\(SELECT COUNT/i);
      expect(analyzeStatement(sql, chatListParams(live, query), 'org-1').violations).toEqual([]);
    }
  });

  it('answers 200 with the DM titled by the other person, and 404 for a stranger', async () => {
    let rows: readonly ChatListDbRow[] = [dm];
    const repo = new ChatListRepository();
    repo.list = async () => rows;
    repo.setMark = async () => true;
    const database = {
      read: (_c: unknown, w: (r: unknown) => unknown) => w({}),
      transaction: (_c: unknown, w: (r: unknown) => unknown) => w({}),
    } as unknown as TenantDatabase;
    const controller = new ChatListController(new ChatListService(database, repo));
    const listed = await controller.list(context, principal, undefined, 'sar');
    expect(listed.rows[0]).toMatchObject({
      title: 'Sara Ali',
      otherUserId: 'sara',
      unreadCount: 2,
      muted: true,
    });
    rows = [];
    await expect(controller.pin(context, principal, 'nope')).rejects.toMatchObject({ status: 404 });
  });
});
