import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { reminderLabel } from '../src/components/meetings/CalendarConnections';
import { offDaysOf } from '../src/components/meetings/MeetingsHub';
import { DateField } from '../src/components/work/DateField';

/** FIX3, live check a6f66e47, item 7. */
const english = (_key: string, fallback: string) => fallback;

describe('reminder options (K2)', () => {
  it('uses the singular for one hour and one day', () => {
    expect(reminderLabel(english, 'en', 60)).toBe('1 hour before');
    expect(reminderLabel(english, 'en', 1440)).toBe('1 day before');
    expect(reminderLabel(english, 'en', 10)).toBe('10 minutes before');
    expect(reminderLabel(english, 'en', 120)).toBe('2 hours before');
  });
});

describe('days off (M4)', () => {
  it('shades Friday and Saturday for a Sunday to Thursday week', () => {
    expect([...offDaysOf([0, 1, 2, 3, 4])].sort()).toEqual([5, 6]);
  });
  it('shades nothing while the working calendar is unknown', () => {
    expect(offDaysOf(undefined).size).toBe(0);
  });
});

describe('the meeting date field (M3)', () => {
  it('is the app date picker, not a native date input', () => {
    const onChange = vi.fn();
    const { container } = render(
      <DateField
        id="d"
        heading="Date"
        value="2026-11-10"
        placeholder="Pick a date"
        required
        onChange={onChange}
      />,
    );
    expect(container.querySelector('input[type="date"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /10/ }));
    expect(screen.getByTestId('due-date-picker')).toBeInTheDocument();
  });
});
