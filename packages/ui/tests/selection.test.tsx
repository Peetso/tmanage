import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Checkbox, Radio, RadioGroup, Switch } from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

describe('Checkbox', () => {
  it('associates a real label with a real checkbox', () => {
    render(<Checkbox label="Also publish to the client" />);
    const control = screen.getByRole('checkbox', { name: 'Also publish to the client' });
    expect(control).toBeInstanceOf(HTMLInputElement);
    expect((control as HTMLInputElement).type).toBe('checkbox');
  });

  it('toggles by click on the control and by click on the label', async () => {
    render(<Checkbox label="Include archived" />);
    const control = screen.getByRole('checkbox', { name: 'Include archived' });

    await userEvent.click(control);
    expect(control).toBeChecked();

    await userEvent.click(screen.getByText('Include archived'));
    expect(control).not.toBeChecked();
  });

  it('toggles with the space key', async () => {
    render(<Checkbox label="Include archived" />);
    const control = screen.getByRole('checkbox', { name: 'Include archived' });

    await userEvent.tab();
    expect(control).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(control).toBeChecked();
  });

  it('reads the hint with the control', () => {
    render(<Checkbox label="Notify the requester" hint="They are told once, on delivery." />);
    expect(screen.getByRole('checkbox')).toHaveAccessibleDescription(
      'They are told once, on delivery.',
    );
  });

  it('is only invalid when it has said why', () => {
    const { rerender } = render(<Checkbox label="Accept the terms" />);
    expect(screen.getByRole('checkbox')).not.toHaveAttribute('aria-invalid');

    rerender(<Checkbox label="Accept the terms" error="You must accept before continuing." />);
    const control = screen.getByRole('checkbox');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription('You must accept before continuing.');
  });

  it('carries the mixed state as a DOM property, so the browser announces it', () => {
    const { rerender } = render(<Checkbox label="Select all" indeterminate />);
    const control = screen.getByRole('checkbox') as HTMLInputElement;
    // The property is what the browser maps to `aria-checked="mixed"`; jsdom stores it
    // but does not compute the mixed state into the tree, so the property is the pin.
    expect(control.indeterminate).toBe(true);
    expect(control).not.toBeChecked();

    rerender(<Checkbox label="Select all" />);
    expect(control.indeterminate).toBe(false);
  });

  it('stops accepting input when disabled', () => {
    render(<Checkbox label="Locked" disabled />);
    expect(screen.getByRole('checkbox', { name: 'Locked' })).toBeDisabled();
  });

  it('has no axe violations across its states', async () => {
    const { container } = render(
      <>
        <Checkbox label="Plain" />
        <Checkbox label="Hinted" hint="Persistent help." defaultChecked />
        <Checkbox label="Mixed" indeterminate />
        <Checkbox label="Refused" error="Say why first." />
        <Checkbox label="Locked" disabled />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('RadioGroup and Radio', () => {
  function AudienceChoice(props: { error?: string; disabled?: boolean }) {
    return (
      <RadioGroup legend="Audience" hint="Who can read this update." {...props}>
        <Radio label="Internal" value="internal" defaultChecked />
        <Radio label="Client-visible" value="client" hint="The client is notified." />
      </RadioGroup>
    );
  }

  it('is a radiogroup named by its legend, with the hint read on the group', () => {
    render(<AudienceChoice />);
    const group = screen.getByRole('radiogroup', { name: 'Audience' });
    expect(group).toHaveAccessibleDescription('Who can read this update.');
  });

  it('gives its radios one generated name, so checking one unchecks the other', async () => {
    render(<AudienceChoice />);
    const internal = screen.getByRole('radio', { name: 'Internal' }) as HTMLInputElement;
    const client = screen.getByRole('radio', { name: 'Client-visible' }) as HTMLInputElement;

    expect(internal.name).toBe(client.name);
    expect(internal.name).not.toBe('');

    expect(internal).toBeChecked();
    await userEvent.click(client);
    expect(client).toBeChecked();
    expect(internal).not.toBeChecked();
  });

  it('keeps two groups on one screen apart without either naming itself', async () => {
    render(
      <>
        <RadioGroup legend="First">
          <Radio label="A" value="a" />
        </RadioGroup>
        <RadioGroup legend="Second">
          <Radio label="B" value="b" />
        </RadioGroup>
      </>,
    );

    const a = screen.getByRole('radio', { name: 'A' }) as HTMLInputElement;
    const b = screen.getByRole('radio', { name: 'B' }) as HTMLInputElement;
    expect(a.name).not.toBe(b.name);

    await userEvent.click(a);
    await userEvent.click(b);
    expect(a).toBeChecked();
    expect(b).toBeChecked();
  });

  it('reads an option hint on the option, not on the group', () => {
    render(<AudienceChoice />);
    expect(screen.getByRole('radio', { name: 'Client-visible' })).toHaveAccessibleDescription(
      'The client is notified.',
    );
    expect(screen.getByRole('radio', { name: 'Internal' })).not.toHaveAccessibleDescription();
  });

  it('puts the error on the group, where the choice lives', () => {
    render(<AudienceChoice error="Pick an audience before posting." />);
    const group = screen.getByRole('radiogroup', { name: 'Audience' });
    expect(group).toHaveAttribute('aria-invalid', 'true');
    expect(group).toHaveAccessibleDescription(
      'Who can read this update. Pick an audience before posting.',
    );
  });

  it('disables every option through the fieldset cascade', () => {
    render(<AudienceChoice disabled />);
    expect(screen.getByRole('radio', { name: 'Internal' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Client-visible' })).toBeDisabled();
  });

  it('refuses to render a Radio outside a RadioGroup', () => {
    expect(() => render(<Radio label="Orphan" />)).toThrow(
      'Radio must be rendered inside a RadioGroup.',
    );
  });

  it('has no axe violations, plain and invalid', async () => {
    const { container } = render(
      <>
        <AudienceChoice />
        <RadioGroup legend="State" error="Pick one.">
          <Radio label="Open" value="open" />
          <Radio label="Done" value="done" />
        </RadioGroup>
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Switch', () => {
  it('is a switch with a real label, off until flipped', async () => {
    render(<Switch label="Email me on delivery" />);
    const control = screen.getByRole('switch', { name: 'Email me on delivery' });
    expect(control).not.toBeChecked();

    await userEvent.click(control);
    expect(control).toBeChecked();
  });

  it('flips with the space key', async () => {
    render(<Switch label="Live updates" />);
    const control = screen.getByRole('switch', { name: 'Live updates' });

    await userEvent.tab();
    expect(control).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(control).toBeChecked();
  });

  it('reads the hint with the control', () => {
    render(<Switch label="Live updates" hint="Applies immediately." />);
    expect(screen.getByRole('switch')).toHaveAccessibleDescription('Applies immediately.');
  });

  it('stops accepting input when disabled', () => {
    render(<Switch label="Locked" disabled defaultChecked />);
    const control = screen.getByRole('switch', { name: 'Locked' });
    expect(control).toBeDisabled();
    expect(control).toBeChecked();
  });

  it('has no axe violations, on, off and disabled', async () => {
    const { container } = render(
      <>
        <Switch label="Off" />
        <Switch label="On" defaultChecked hint="Applies immediately." />
        <Switch label="Locked" disabled />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});
