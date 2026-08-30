import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button, Select, Toast, ToastRegion, Tooltip } from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

describe('Select', () => {
  function StateFilter(props: { error?: string; hint?: string; disabled?: boolean }) {
    return (
      <Select label="State" {...props}>
        <option value="">Any state</option>
        <option value="in_progress">In progress</option>
        <option value="blocked">Blocked</option>
      </Select>
    );
  }

  it('associates a real label with a real select', () => {
    render(<StateFilter />);
    const control = screen.getByRole('combobox', { name: 'State' });
    expect(control).toBeInstanceOf(HTMLSelectElement);
  });

  it('selects an option and reports its value', async () => {
    render(<StateFilter />);
    const control = screen.getByRole('combobox', { name: 'State' });

    await userEvent.selectOptions(control, 'Blocked');
    expect(control).toHaveValue('blocked');
    expect((screen.getByRole('option', { name: 'Blocked' }) as HTMLOptionElement).selected).toBe(
      true,
    );
  });

  it('reads the hint with the control', () => {
    render(<StateFilter hint="Filters the list below." />);
    expect(screen.getByRole('combobox')).toHaveAccessibleDescription('Filters the list below.');
  });

  it('is only invalid when it has said why', () => {
    const { rerender } = render(<StateFilter />);
    expect(screen.getByRole('combobox')).not.toHaveAttribute('aria-invalid');

    rerender(<StateFilter error="Pick a state." />);
    const control = screen.getByRole('combobox');
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveAccessibleDescription('Pick a state.');
  });

  it('stops accepting input when disabled', () => {
    render(<StateFilter disabled />);
    expect(screen.getByRole('combobox', { name: 'State' })).toBeDisabled();
  });

  it('has no axe violations across its states', async () => {
    const { container } = render(
      <>
        <StateFilter hint="Filters the list below." />
        <StateFilter error="Pick a state." />
        <StateFilter disabled />
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Tooltip', () => {
  it('describes the trigger permanently, visible or not', () => {
    render(
      <Tooltip content="Publishes to the client portal.">
        <Button tone="outline">Publish</Button>
      </Tooltip>,
    );

    const trigger = screen.getByRole('button', { name: 'Publish' });
    // The description mechanism does not depend on the bubble being drawn.
    expect(trigger).toHaveAccessibleDescription('Publishes to the client portal.');
    expect(screen.getByRole('tooltip')).not.toHaveAttribute('data-open');
  });

  it('opens on keyboard focus, not only on hover, and closes on blur', async () => {
    render(
      <Tooltip content="Publishes to the client portal.">
        <Button tone="outline">Publish</Button>
      </Tooltip>,
    );

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-open');

    await userEvent.tab();
    expect(screen.getByRole('tooltip')).not.toHaveAttribute('data-open');
  });

  it('opens on hover and closes when the pointer leaves', async () => {
    render(
      <Tooltip content="Publishes to the client portal.">
        <Button tone="outline">Publish</Button>
      </Tooltip>,
    );

    await userEvent.hover(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-open');

    await userEvent.unhover(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByRole('tooltip')).not.toHaveAttribute('data-open');
  });

  it('dismisses on Escape while focus stays where it was — WCAG 1.4.13', async () => {
    render(
      <Tooltip content="Publishes to the client portal.">
        <Button tone="outline">Publish</Button>
      </Tooltip>,
    );

    await userEvent.tab();
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-open');

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('tooltip')).not.toHaveAttribute('data-open');
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();
  });

  it('dismisses a hover-only tooltip on Escape, when focus is somewhere else entirely', async () => {
    render(
      <>
        <Tooltip content="Publishes to the client portal.">
          <Button tone="outline">Publish</Button>
        </Tooltip>
        <Button tone="outline">Elsewhere</Button>
      </>,
    );

    // Focus one control, hover the other: 1.4.13's mouse-user case.
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await userEvent.hover(screen.getByRole('button', { name: 'Publish' }));
    expect(screen.getByRole('tooltip')).toHaveAttribute('data-open');

    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('tooltip')).not.toHaveAttribute('data-open');
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });

  it('keeps a describedby the trigger already had', () => {
    render(
      <>
        <span id="existing">Already said.</span>
        <Tooltip content="And this too.">
          <button type="button" aria-describedby="existing">
            Act
          </button>
        </Tooltip>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Act' })).toHaveAccessibleDescription(
      'Already said. And this too.',
    );
  });

  it('has no axe violations, closed and open', async () => {
    const { container } = render(
      <>
        <Tooltip content="Closed.">
          <Button tone="outline">One</Button>
        </Tooltip>
        <Tooltip content="Open." defaultOpen>
          <Button tone="outline">Two</Button>
        </Tooltip>
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('ToastRegion and Toast', () => {
  it('is a polite status region, present and named before any toast exists', () => {
    render(<ToastRegion />);
    const region = screen.getByRole('status', { name: 'Notifications' });
    expect(region).toBeEmptyDOMElement();
    // role="status" is implicitly atomic; left that way, toast #4 re-announces #1-#3.
    expect(region).toHaveAttribute('aria-atomic', 'false');
  });

  it('renders the sentence with a glyph and, only when dismissable, a labelled button', () => {
    const { rerender } = render(
      <ToastRegion>
        <Toast tone="success">Work item created.</Toast>
      </ToastRegion>,
    );

    expect(screen.getByText('Work item created.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();

    const onDismiss = vi.fn();
    rerender(
      <ToastRegion>
        <Toast tone="success" onDismiss={onDismiss}>
          Work item created.
        </Toast>
      </ToastRegion>,
    );

    expect(screen.getByRole('button', { name: 'Dismiss notification' })).toBeInTheDocument();
  });

  it('fires onDismiss and nothing else when the button is pressed', async () => {
    const onDismiss = vi.fn();
    render(
      <ToastRegion>
        <Toast onDismiss={onDismiss}>Saved.</Toast>
      </ToastRegion>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations across the tones', async () => {
    const { container } = render(
      <ToastRegion>
        <Toast>Neutral.</Toast>
        <Toast tone="success">Done.</Toast>
        <Toast tone="warning">Careful.</Toast>
        <Toast tone="danger" onDismiss={() => {}}>
          Failed.
        </Toast>
      </ToastRegion>,
    );
    await expectNoAxeViolations(container);
  });
});
