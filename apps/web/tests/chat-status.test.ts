import { describe, expect, it } from 'vitest';
import { tickState } from '../src/components/chat/status/MessageTicks';
import { typingSentence } from '../src/components/chat/status/TypingIndicator';
import { presenceText } from '../src/components/chat/status/PresenceLabel';
import { shouldNotifyChat } from '../src/components/pwa/ChatNotificationBridge';
import type { MessageKey } from '../src/lib/i18n/t';

const t = (key: MessageKey): string => key;
const entry = (userId: string) => ({ userId, displayName: userId, at: '2026-11-01T14:02:00Z' });

describe('R7 chat status', () => {
  it('ticks: pending, sent, delivered, then read once everyone it reached has read', () => {
    expect(tickState({ id: null, pending: true })).toBe('pending');
    expect(tickState({ id: 'm1' })).toBe('sent');
    const two = [entry('a'), entry('b')];
    expect(tickState({ id: 'm1' }, { deliveredTo: two, readBy: [entry('a')] })).toBe('delivered');
    expect(tickState({ id: 'm1' }, { deliveredTo: two, readBy: two })).toBe('read');
  });

  it('typing sentence names one, two, or one and a count', () => {
    expect(typingSentence([], t)).toBeNull();
    expect(typingSentence(['Sara', 'Omar', 'Lina'], t)).toBe('ChatStatus.typingMany');
  });

  it('presence hides a hidden last seen and says online', () => {
    expect(presenceText({ userId: 'u', online: false, lastSeenAt: null }, t, 'en')).toBeNull();
    expect(presenceText({ userId: 'u', online: true, lastSeenAt: null }, t, 'en')).toBe(
      'ChatStatus.online',
    );
  });

  it('notifies unless the conversation is on screen or muted', () => {
    const base = { conversationId: 'c1', openConversationId: 'c1', visible: true, muted: false };
    expect(shouldNotifyChat(base)).toBe(false);
    expect(shouldNotifyChat({ ...base, visible: false })).toBe(true);
    expect(shouldNotifyChat({ ...base, openConversationId: 'c2', muted: true })).toBe(false);
  });
});
