import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatListRow } from '../src/components/chat/ChatListRow';
import type { ChatListRowData } from '../src/lib/api/chat';

const row: ChatListRowData = {
  conversationId: 'c1',
  kind: 'direct',
  title: 'سارة علي',
  projectId: null,
  photoFileAssetId: null,
  lastMessage: { excerpt: 'Hello', kind: 'text', authorName: 'Sara', at: '2026-11-01T10:00:00Z' },
  unreadCount: 3,
  pinnedAt: '2026-11-01T09:00:00Z',
  muted: false,
  archivedAt: null,
  otherUserId: 'sara',
};

describe('ChatListRow (R7 slice 2)', () => {
  it('shows the unread badge and pin, and keeps the title in its own direction under rtl', () => {
    render(
      <ul dir="rtl">
        <ChatListRow row={row} href="/acme/chat/c1" now={new Date('2026-11-01T12:00:00Z')} />
      </ul>,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/acme/chat/c1');
    expect(link.textContent).toContain('3');
    expect(screen.getByText(/3 unread messages/)).toBeTruthy();
    expect(screen.getByText('سارة علي').tagName).toBe('BDI');
    expect(link.closest('[dir="rtl"]')).not.toBeNull();
  });
});
