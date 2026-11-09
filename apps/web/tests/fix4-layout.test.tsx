import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DateField } from '../src/components/work/DateField';

/** FIX4 item 6 (C2): the date picker's month grid was cut off at the bottom of the screen. */

function openPickerWithFieldAt(top: number, bottom: number, panelHeight: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        top,
        bottom,
        left: 0,
        right: 200,
        width: 200,
        height: bottom - top,
        x: 0,
        y: top,
      }) as DOMRect,
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(panelHeight);
  render(
    <DateField
      id="d"
      heading="Date"
      value="2026-11-10"
      placeholder="Pick a date"
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /10/ }));
  return screen.getByTestId('due-date-picker');
}

describe('FIX4 item 6: the date picker stays on screen', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens below a field with room under it', () => {
    const panel = openPickerWithFieldAt(100, 140, 420);
    expect(panel).toHaveAttribute('data-side', 'below');
    expect(panel.style.maxBlockSize).toBe('');
  });

  it('opens above a field near the bottom of the screen', () => {
    const panel = openPickerWithFieldAt(window.innerHeight - 60, window.innerHeight - 20, 420);
    expect(panel).toHaveAttribute('data-side', 'above');
    expect(panel.style.maxBlockSize).toBe('');
  });

  it('scrolls inside itself when neither side has room for the whole month', () => {
    const middle = window.innerHeight / 2;
    const panel = openPickerWithFieldAt(middle - 20, middle + 20, window.innerHeight);
    expect(panel.style.maxBlockSize).not.toBe('');
    expect(panel.style.overflowY).toBe('auto');
  });
});
