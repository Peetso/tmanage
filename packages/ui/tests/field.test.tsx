import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Field, SearchField } from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

describe('Field', () => {
  it('associates a real label with the control', () => {
    render(<Field label="Work item title" />);
    expect(screen.getByLabelText('Work item title')).toBeInstanceOf(HTMLInputElement);
  });

  it('gives two fields on the same screen different ids', () => {
    render(
      <>
        <Field label="First" />
        <Field label="Second" />
      </>,
    );

    const first = screen.getByLabelText('First');
    const second = screen.getByLabelText('Second');
    expect(first.id).not.toBe(second.id);
  });

  it('reads the hint with the field', () => {
    render(<Field label="Slug" hint="Lower case, no spaces." />);
    expect(screen.getByLabelText('Slug')).toHaveAccessibleDescription('Lower case, no spaces.');
  });

  it('is only invalid when it has said why', () => {
    const { rerender } = render(<Field label="Slug" />);
    expect(screen.getByLabelText('Slug')).not.toHaveAttribute('aria-invalid');

    rerender(<Field label="Slug" error="That slug is already taken." />);
    const control = screen.getByLabelText('Slug');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    // The glyph is `aria-hidden`, so the description is the sentence and nothing else.
    expect(control).toHaveAccessibleDescription('That slug is already taken.');
  });

  it('reads the hint before the error, so the rule comes before the failure', () => {
    render(<Field label="Slug" hint="Lower case, no spaces." error="That slug is taken." />);
    expect(screen.getByLabelText('Slug')).toHaveAccessibleDescription(
      'Lower case, no spaces. That slug is taken.',
    );
  });

  it('does not read the required asterisk aloud — `required` already carries it', () => {
    render(<Field label="Title" required />);
    // Queried by accessible name rather than by label text: the label's *text* is
    // "Title *", and the point of the test is that its *name* is not.
    const control = screen.getByRole('textbox', { name: 'Title' });
    expect(control).toBeRequired();
    expect(control).toHaveAccessibleName('Title');
  });

  it('accepts typing, and stops accepting it when disabled', async () => {
    const { rerender } = render(<Field label="Title" />);
    await userEvent.type(screen.getByLabelText('Title'), 'Homepage direction');
    expect(screen.getByLabelText('Title')).toHaveValue('Homepage direction');

    rerender(<Field label="Title" disabled />);
    expect(screen.getByLabelText('Title')).toBeDisabled();
  });

  it('has no axe violations, invalid or valid', async () => {
    const { container } = render(
      <>
        <Field label="Title" hint="Say what changes." />
        <Field label="Slug" required error="That slug is already taken." />
        <Field label="Locked" readOnly value="fixed" onChange={() => {}} />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('SearchField', () => {
  it('is a search box with a name, even when the name is not drawn', () => {
    render(<SearchField label="Search work items" />);
    const control = screen.getByRole('searchbox', { name: 'Search work items' });
    expect(control).toHaveClass('tm-search-field__control');
  });

  it('can show its label when a screen wants it visible', () => {
    render(<SearchField label="Search" labelVisible />);
    expect(screen.getByText('Search')).toHaveClass('tm-field__label');
  });

  it('has no axe violations', async () => {
    const { container } = render(<SearchField label="Search work items" placeholder="Search" />);
    await expectNoAxeViolations(container);
  });
});
