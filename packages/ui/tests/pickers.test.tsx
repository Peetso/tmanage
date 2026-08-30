import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox, DateField, TimeField } from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

const PEOPLE = [
  { value: 'nr', label: 'Nadia Rahman' },
  { value: 'jp', label: 'Jonas Petersen' },
  { value: 'ah', label: 'Amina Haddad' },
] as const;

describe('Combobox', () => {
  it('is a labelled combobox that starts closed and truthful about it', () => {
    render(<Combobox label="Owner" options={PEOPLE} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveAttribute('aria-autocomplete', 'list');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('opens and filters as the person types, case-insensitively', async () => {
    render(<Combobox label="Owner" options={PEOPLE} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.type(input, 'na');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    // "na" is in Nadia Rahman and in Amina Haddad ("Amina" and "Jonas" — no, Jonas has "na"
    // too: Jo-na-s). All three labels contain "na"; narrow further.
    await userEvent.type(input, 'di');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Nadia Rahman');
  });

  it('moves a virtual focus with the arrows while DOM focus stays on the input', async () => {
    render(<Combobox label="Owner" options={PEOPLE} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'true');

    const [first, second] = screen.getAllByRole('option');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(input).toHaveAttribute('aria-activedescendant', first?.id);
    expect(first).toHaveAttribute('data-active');

    await userEvent.keyboard('{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', second?.id);
    expect(input).toHaveFocus();
  });

  it('selects the active option with Enter: label to the eye, value to the form', async () => {
    const onValueChange = vi.fn();
    render(<Combobox label="Owner" options={PEOPLE} onValueChange={onValueChange} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onValueChange).toHaveBeenCalledWith('jp');
    expect(input).toHaveValue('Jonas Petersen');
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('closes on Escape without selecting anything', async () => {
    const onValueChange = vi.fn();
    render(<Combobox label="Owner" options={PEOPLE} onValueChange={onValueChange} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}{Escape}');

    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('selects by pointer without the input blur stealing the popup first', async () => {
    const onValueChange = vi.fn();
    render(<Combobox label="Owner" options={PEOPLE} onValueChange={onValueChange} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.type(input, 'Amina');
    await userEvent.click(screen.getByRole('option', { name: 'Amina Haddad' }));

    expect(onValueChange).toHaveBeenCalledWith('ah');
    expect(input).toHaveValue('Amina Haddad');
  });

  it('says "no matches" rather than silently vanishing, and says it out loud', async () => {
    render(<Combobox label="Owner" options={PEOPLE} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    // The announcement channel exists from mount, empty — a live region inserted
    // together with its first content is routinely not announced.
    expect(screen.getByRole('status')).toHaveTextContent('');

    await userEvent.type(input, 'zz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    // Twice: the visible row in the popup, and the status region a screen reader hears.
    expect(screen.getAllByText('No matches')).toHaveLength(2);
    expect(screen.getByRole('status')).toHaveTextContent('No matches');
  });

  it('reports a cleared input as a cleared value', async () => {
    const onValueChange = vi.fn();
    render(<Combobox label="Owner" options={PEOPLE} value="nr" onValueChange={onValueChange} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });
    expect(input).toHaveValue('Nadia Rahman');

    await userEvent.clear(input);
    expect(onValueChange).toHaveBeenCalledWith('');
  });

  it('marks the chosen option aria-selected when the popup reopens', async () => {
    render(<Combobox label="Owner" options={PEOPLE} value="jp" />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Jonas Petersen' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('re-syncs the visible text when the value prop changes after mount', () => {
    const { rerender } = render(<Combobox label="Owner" options={PEOPLE} value="nr" />);
    const input = screen.getByRole('combobox', { name: 'Owner' });
    expect(input).toHaveValue('Nadia Rahman');

    rerender(<Combobox label="Owner" options={PEOPLE} value="jp" />);
    expect(input).toHaveValue('Jonas Petersen');

    rerender(<Combobox label="Owner" options={PEOPLE} value="" />);
    expect(input).toHaveValue('');
  });

  it('picks up a value whose options arrive after mount', () => {
    const { rerender } = render(<Combobox label="Owner" options={[]} value="nr" />);
    const input = screen.getByRole('combobox', { name: 'Owner' });
    expect(input).toHaveValue('');

    rerender(<Combobox label="Owner" options={PEOPLE} value="nr" />);
    expect(input).toHaveValue('Nadia Rahman');
  });

  it('reverts half-edited text on blur, so the eye and the form cannot disagree', async () => {
    render(
      <>
        <Combobox label="Owner" options={PEOPLE} value="nr" />
        <button type="button">Elsewhere</button>
      </>,
    );
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.type(input, '{Backspace}');
    expect(input).toHaveValue('Nadia Rahma');

    await userEvent.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(input).toHaveValue('Nadia Rahman');
  });

  it('enters the list at the bottom on ArrowUp, at the top on ArrowDown', async () => {
    render(<Combobox label="Owner" options={PEOPLE} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.click(input);
    await userEvent.keyboard('{ArrowUp}');
    const options = screen.getAllByRole('option');
    expect(input).toHaveAttribute('aria-activedescendant', options[options.length - 1]?.id);

    await userEvent.keyboard('{Escape}{ArrowDown}');
    expect(input).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]?.id);
  });

  it('swallows Enter while the popup is open, so a form cannot submit mid-filter', async () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const onValueChange = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Combobox label="Owner" options={PEOPLE} onValueChange={onValueChange} />
      </form>,
    );
    const input = screen.getByRole('combobox', { name: 'Owner' });

    // Typing opens the popup with nothing active; Enter must close it, not submit.
    await userEvent.type(input, 'na{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-expanded', 'false');

    // Closed popup: Enter reaches the form as usual.
    await userEvent.keyboard('{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('builds option ids from the index, never from form data', async () => {
    render(<Combobox label="Owner" options={[{ value: 'has spaces & things', label: 'Odd' }]} />);
    const input = screen.getByRole('combobox', { name: 'Owner' });

    await userEvent.click(input);
    await userEvent.keyboard('{ArrowDown}');
    const active = input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(active).not.toContain(' ');
    expect(screen.getByRole('option', { name: 'Odd' }).id).toBe(active);
  });

  it('follows the Field contract for hint, error and aria-invalid', () => {
    const { rerender } = render(
      <Combobox label="Owner" options={PEOPLE} hint="Start typing a name." />,
    );
    const input = screen.getByRole('combobox');
    expect(input).toHaveAccessibleDescription('Start typing a name.');
    expect(input).not.toHaveAttribute('aria-invalid');

    rerender(
      <Combobox
        label="Owner"
        options={PEOPLE}
        hint="Start typing a name."
        error="Pick an owner from the list."
      />,
    );
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Start typing a name. Pick an owner from the list.');
  });

  it('has no axe violations, closed and open', async () => {
    const { container } = render(
      <>
        <Combobox label="Closed" options={PEOPLE} />
        <Combobox label="Open" options={PEOPLE} defaultOpen value="nr" />
        <Combobox label="Refused" options={PEOPLE} error="Pick one." />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('DateField', () => {
  it('is a native date input whose value is the YYYY-MM-DD string, not a Date', () => {
    const onValueChange = vi.fn();
    render(
      <DateField label="Committed day" defaultValue="2026-09-15" onValueChange={onValueChange} />,
    );

    const input = screen.getByLabelText('Committed day') as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(input).toHaveValue('2026-09-15');

    fireEvent.change(input, { target: { value: '2026-10-01' } });
    expect(onValueChange).toHaveBeenCalledWith('2026-10-01');
    expect(onValueChange.mock.calls[0]?.[0]).toBeTypeOf('string');
  });

  it('reports clearing as the empty string, never as null or a sentinel', () => {
    const onValueChange = vi.fn();
    render(
      <DateField label="Committed day" defaultValue="2026-09-15" onValueChange={onValueChange} />,
    );

    fireEvent.change(screen.getByLabelText('Committed day'), { target: { value: '' } });
    expect(onValueChange).toHaveBeenCalledWith('');
  });

  it('follows the Field contract for hint, error and aria-invalid', () => {
    render(
      <DateField
        label="Committed day"
        hint="The day you are promising."
        error="A committed day cannot be in the past."
      />,
    );
    const input = screen.getByLabelText('Committed day');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(
      'The day you are promising. A committed day cannot be in the past.',
    );
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <>
        <DateField label="Committed day" defaultValue="2026-09-15" />
        <DateField label="Refused" error="Say when." required />
        <DateField label="Locked" disabled defaultValue="2026-09-15" />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('TimeField', () => {
  it('is a native time input speaking HH:MM, the wall-clock twin', () => {
    const onValueChange = vi.fn();
    render(<TimeField label="Handoff time" defaultValue="14:30" onValueChange={onValueChange} />);

    const input = screen.getByLabelText('Handoff time') as HTMLInputElement;
    expect(input.type).toBe('time');
    expect(input).toHaveValue('14:30');

    fireEvent.change(input, { target: { value: '09:05' } });
    expect(onValueChange).toHaveBeenCalledWith('09:05');
  });

  it('follows the Field contract and has no axe violations', async () => {
    const { container } = render(
      <>
        <TimeField label="Handoff time" hint="Their local afternoon." />
        <TimeField label="Refused" error="Say when in the day." />
      </>,
    );
    expect(screen.getByLabelText('Handoff time')).toHaveAccessibleDescription(
      'Their local afternoon.',
    );
    expect(screen.getByLabelText('Refused')).toHaveAttribute('aria-invalid', 'true');
    await expectNoAxeViolations(container);
  });
});
