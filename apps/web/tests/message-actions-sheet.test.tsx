import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageActionsSheet } from '../src/components/chat/MessageActionsSheet';

/**
 * A16 — the phone message actions sheet (Figma 386:4027 / 386:4167): quick reactions ♥ ✓ ☺ ★ +
 * over Reply in thread · Edit message · Copy text · Save attachment · Delete message. Each action
 * runs its handler and closes the sheet; an action that does not apply is not drawn at all.
 */
describe('MessageActionsSheet', () => {
  function renderSheet() {
    const props = {
      reacted: new Set(['❤️']),
      onReact: vi.fn(),
      onMoreReactions: vi.fn(),
      onReply: vi.fn(),
      onEdit: vi.fn(),
      onCopy: vi.fn(),
      attachmentHref: 'https://api.example.test/v1/organizations/n/files/f-1/content',
      attachmentName: 'atlas-mobile-flow-v3.pdf',
      onDelete: vi.fn(),
      onClose: vi.fn(),
    };
    render(<MessageActionsSheet {...props} />);
    return props;
  }

  it('draws the quick reactions and every action, focuses the first reaction, and reacts', async () => {
    const props = renderSheet();
    const sheet = screen.getByRole('dialog', { name: 'Message actions' });

    const heart = within(sheet).getByRole('button', { name: 'Heart' });
    expect(heart).toHaveFocus();
    expect(heart).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('button', { name: 'Done' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(within(sheet).getByRole('button', { name: 'Smiling' })).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Star' })).toBeInTheDocument();
    for (const name of ['Reply in thread', 'Edit message', 'Copy text', 'Delete message']) {
      expect(within(sheet).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(sheet).getByRole('link', { name: 'Save attachment' })).toHaveAttribute(
      'download',
      'atlas-mobile-flow-v3.pdf',
    );

    await userEvent.click(within(sheet).getByRole('button', { name: 'Star' }));
    expect(props.onReact).toHaveBeenCalledWith('\u{2605}');
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('hands Delete and Edit back to the channel and closes', async () => {
    const props = renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'Delete message' }));
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Edit message' }));
    expect(props.onEdit).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('leaves out what does not apply and closes on Escape', async () => {
    const onClose = vi.fn();
    render(
      <MessageActionsSheet
        reacted={new Set()}
        onReact={vi.fn()}
        onMoreReactions={vi.fn()}
        onReply={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy text' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Save attachment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete message' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reply in thread' })).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
