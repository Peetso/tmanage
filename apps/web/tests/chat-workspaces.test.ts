import { describe, expect, it } from 'vitest';
import {
  chatHref,
  chatWorkspaceFrom,
  chatWorkspaceTabs,
  newGroupHref,
  sectionChatRows,
  workspaceUnread,
} from '../src/components/chat/chat-workspaces';
import type { ChatListRowData } from '../src/lib/api/chat';
import type { OrganizationSummary } from '../src/lib/api/organizations';

function row(over: Partial<ChatListRowData>): ChatListRowData {
  return {
    conversationId: 'c',
    kind: 'group',
    title: 't',
    projectId: null,
    photoFileAssetId: null,
    lastMessage: null,
    unreadCount: 0,
    pinnedAt: null,
    muted: false,
    archivedAt: null,
    otherUserId: null,
    ...over,
  };
}

function org(slug: string, over: Partial<OrganizationSummary> = {}): OrganizationSummary {
  return {
    id: slug,
    slug,
    name: slug,
    audience: 'internal',
    role: 'member',
    clientOrganizationName: null,
    ...over,
  };
}

describe('R38 G1 chat sections', () => {
  it('puts project-free groups under General, channels under Projects, people under Direct', () => {
    const sections = sectionChatRows([
      row({ conversationId: 'p', kind: 'project_channel', projectId: 'pr1' }),
      row({ conversationId: 'd', kind: 'direct' }),
      row({ conversationId: 'g' }),
    ]);
    expect(sections.map((s) => [s.id, s.rows.map((r) => r.conversationId)])).toEqual([
      ['general', ['g']],
      ['projects', ['p']],
      ['direct', ['d']],
    ]);
  });
});

describe('R38 G2 chat workspaces', () => {
  it('keeps the shell workspace in the path and the chat workspace in ?ws=', () => {
    expect(chatHref('north', 'atlas', 'c1')).toBe('/north/chat/c1?ws=atlas');
    expect(chatHref('north', 'north', 'c1')).toBe('/north/chat/c1');
    expect(newGroupHref('north', 'atlas')).toBe('/north/chat?ws=atlas&new=group');
    expect(newGroupHref('north')).toBe('/north/chat?new=group');
  });

  it('ignores a ?ws= that is not slug-shaped or is the shell itself', () => {
    expect(chatWorkspaceFrom('north', 'atlas')).toBe('atlas');
    expect(chatWorkspaceFrom('north', 'north')).toBeUndefined();
    expect(chatWorkspaceFrom('north', '../x')).toBeUndefined();
    expect(chatWorkspaceFrom('north', undefined)).toBeUndefined();
  });

  it('offers only internal, live memberships, the shell first', () => {
    const tabs = chatWorkspaceTabs(
      [
        org('atlas'),
        org('north'),
        org('client', { audience: 'client' }),
        org('off', { suspended: true }),
      ],
      'north',
    );
    expect(tabs.map((o) => o.slug)).toEqual(['north', 'atlas']);
  });

  it('counts unread only in chats that are neither archived nor muted', () => {
    expect(
      workspaceUnread([
        row({ unreadCount: 3 }),
        row({ unreadCount: 5, muted: true }),
        row({ unreadCount: 7, archivedAt: '2026-11-01T00:00:00Z' }),
      ]),
    ).toBe(3);
  });
});
