import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MessageBubble } from '../src/components/chat/pane/MessageBubble';
import type { MessageSummary } from '../src/lib/api/conversations';

/** R7 slice 4: own vs other, the tombstone, the reply quote. */
const base = {
  id: 'm2',
  conversationId: 'c1',
  authorUserId: 'u1',
  sequenceNo: 2,
  parentMessageId: null,
  kind: 'text',
  meta: null,
  body: 'Thanks',
  bodyRich: null,
  editedAt: null,
  deletedAt: null,
  deletedByUserId: null,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
} as MessageSummary;
const nameOf = (id: string) => (id === 'u2' ? 'Sami' : 'You');

describe('MessageBubble', () => {
  it('draws own and other bubbles, a reply quote and the deleted tombstone', () => {
    const reply = {
      ...base,
      meta: { replyToMessageId: 'm1', authorUserId: 'u2', excerpt: 'Ready?' },
    };
    const { container } = render(
      <>
        <MessageBubble message={reply} own nameOf={nameOf} body={<p>Thanks</p>} />
        <MessageBubble
          message={{ ...base, id: 'm3', authorUserId: 'u2' }}
          own={false}
          nameOf={nameOf}
          showAuthor
          authorName="Sami"
          body={<p>Hi</p>}
        />
        <MessageBubble
          message={{
            ...base,
            id: 'm4',
            deletedAt: base.createdAt,
            deletedByUserId: 'u1',
            body: null,
          }}
          own
          nameOf={nameOf}
        />
      </>,
    );
    const bubbles = container.querySelectorAll('.tm-pane-bubble');
    expect([...bubbles].map((b) => b.getAttribute('data-own'))).toEqual(['true', 'false', 'true']);
    expect(screen.getByRole('button', { name: /Sami/ })).toHaveTextContent('Ready?');
    expect(screen.getByText('This message was deleted')).toBeInTheDocument();
  });
});
