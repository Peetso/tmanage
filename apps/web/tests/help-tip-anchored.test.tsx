import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HELP_TIP_DELAY_MS, HelpTip } from '../src/components/help/HelpTip';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function rect(top: number, left: number, width: number, height: number): DOMRect {
  return {
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('HelpTip — anchored hover help (2026-11-09)', () => {
  it('beside a control at the viewport edge, flips to the other side and keeps its arrow', () => {
    // jsdom's window is 1024 wide: a rail item at the right edge has no room after it.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('tm-tooltip__bubble')) return rect(0, 0, 220, 36);
      if (this.classList.contains('tm-tooltip')) return rect(300, 960, 56, 40);
      return rect(0, 0, 0, 0);
    });
    vi.useFakeTimers();
    render(
      <HelpTip tip="Open your projects." placement="end">
        <button type="button">Projects</button>
      </HelpTip>,
    );
    const trigger = screen.getByRole('button', { name: 'Projects' });
    fireEvent.mouseEnter(trigger.parentElement!);
    const bubble = screen.getByRole('tooltip');
    expect(bubble).not.toHaveAttribute('data-open');
    act(() => {
      vi.advanceTimersByTime(HELP_TIP_DELAY_MS);
    });
    expect(bubble).toHaveAttribute('data-open');
    expect(bubble).toHaveAttribute('data-side', 'left');
    expect(bubble.style.left).toBe(`${960 - 8 - 220}px`);
    expect(bubble.querySelector('.tm-tooltip__arrow')).not.toBeNull();
    expect(trigger.getAttribute('aria-describedby')).toBe(bubble.id);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(bubble).not.toHaveAttribute('data-open');
  });
});
