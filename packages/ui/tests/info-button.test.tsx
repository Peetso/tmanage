import { act, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfoButton, MOTION_DELAY_TOOLTIP_MS, Tooltip } from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

/**
 * My Day v3 spec §4 checks C12 (popover behaviour), C13 (tooltip timing) and C14 (WCAG 1.4.13).
 * APG Disclosure pattern: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/ ; APG Tooltip
 * pattern: https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/ .
 */
describe('InfoButton (APG disclosure: https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)', () => {
  function Two() {
    return (
      <>
        <InfoButton title="Due & at risk" label="About Due & at risk">
          Your work that is late, due today or due soon.
        </InfoButton>
        <InfoButton title="Waiting" label="About Waiting">
          Approvals and client requests.
        </InfoButton>
        <button type="button">Elsewhere</button>
      </>
    );
  }

  it('is a named button that opens on click and closes on a second click', async () => {
    render(<Two />);
    const button = screen.getByRole('button', { name: 'About Due & at risk' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Your work that is late, due today or due soon.')).toBeVisible();
    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens on Enter and on Space, and Escape returns focus to the button', async () => {
    render(<Two />);
    const button = screen.getByRole('button', { name: 'About Due & at risk' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps only one open, and a click outside closes it', async () => {
    render(<Two />);
    const first = screen.getByRole('button', { name: 'About Due & at risk' });
    const second = screen.getByRole('button', { name: 'About Waiting' });
    await userEvent.click(first);
    await userEvent.click(second);
    expect(first).toHaveAttribute('aria-expanded', 'false');
    expect(second).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(second).toHaveAttribute('aria-expanded', 'false');
  });

  it('has no axe violations while open', async () => {
    const { container } = render(<Two />);
    await userEvent.click(screen.getByRole('button', { name: 'About Waiting' }));
    await expectNoAxeViolations(container);
  });
});

describe('Tooltip timing (APG tooltip: https://www.w3.org/WAI/ARIA/apg/patterns/tooltip/)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the rest delay is the 700 ms motion.delay.tooltip target', () => {
    expect(MOTION_DELAY_TOOLTIP_MS).toBe(700);
  });

  it('shows after the pointer rests the delay, not before, and on focus at once', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Open work assigned to you." delayMs={MOTION_DELAY_TOOLTIP_MS}>
        <button type="button">7 Open</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: '7 Open' });
    const bubble = screen.getByRole('tooltip', { hidden: true });
    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    act(() => vi.advanceTimersByTime(MOTION_DELAY_TOOLTIP_MS - 100));
    expect(bubble).not.toHaveAttribute('data-open');
    act(() => vi.advanceTimersByTime(100));
    expect(bubble).toHaveAttribute('data-open');
    // Escape dismisses without moving the pointer or the focus (WCAG 1.4.13 dismissible).
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bubble).not.toHaveAttribute('data-open');
    fireEvent.mouseLeave(button.parentElement as HTMLElement);
    act(() => vi.advanceTimersByTime(1000));
    act(() => button.focus());
    expect(bubble).toHaveAttribute('data-open');
  });

  it('does not open from a touch', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Meetings on your calendar today." delayMs={MOTION_DELAY_TOOLTIP_MS}>
        <button type="button">2 Meetings</button>
      </Tooltip>,
    );
    const wrapper = screen.getByRole('button', { name: '2 Meetings' }).parentElement as HTMLElement;
    fireEvent.touchStart(wrapper);
    fireEvent.mouseEnter(wrapper);
    act(() => vi.advanceTimersByTime(MOTION_DELAY_TOOLTIP_MS * 2));
    expect(screen.getByRole('tooltip', { hidden: true })).not.toHaveAttribute('data-open');
  });
});
