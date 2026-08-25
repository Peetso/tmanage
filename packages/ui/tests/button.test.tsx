import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  DestructiveButton,
  InkButton,
  LimeButton,
  OrbButton,
  OutlineButton,
  SplitCapsuleButton,
  TextButton,
} from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

describe('Button', () => {
  it('is a button, not a submit, unless it is asked to be', () => {
    const { rerender } = render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');

    rerender(<Button type="submit">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
  });

  it('carries the tone and size in stable class names', () => {
    render(
      <Button tone="lime" size="accessible">
        Start
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Start' });
    expect(button).toHaveClass('tm-button', 'tm-button--lime', 'tm-button--accessible');
  });

  it('defaults to the ink tone and the 40px control', () => {
    render(<Button>Default</Button>);
    expect(screen.getByRole('button', { name: 'Default' })).toHaveClass(
      'tm-button--ink',
      'tm-button--default',
    );
  });

  it('clicks', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Publish</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is reachable and operable from the keyboard alone', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Publish</Button>);

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  describe('loading', () => {
    it('disables the button, marks it busy, and says so', () => {
      render(
        <Button loading loadingLabel="Publishing the version">
          Publish
        </Button>,
      );

      const button = screen.getByRole('button', { name: /Publish/ });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(screen.getByRole('status')).toHaveTextContent('Publishing the version');
    });

    it('keeps the visible label, so the control does not resize under the pointer', () => {
      render(<Button loading>Publish</Button>);
      expect(screen.getByRole('button', { name: /^Publish/ })).toBeInTheDocument();
    });

    it('cannot be clicked while it waits', async () => {
      const onClick = vi.fn();
      render(
        <Button loading onClick={onClick}>
          Publish
        </Button>,
      );
      await userEvent.click(screen.getByRole('button', { name: /Publish/ }));
      expect(onClick).not.toHaveBeenCalled();
    });

    it('is not busy when it is not loading', () => {
      render(<Button>Publish</Button>);
      expect(screen.getByRole('button', { name: 'Publish' })).not.toHaveAttribute('aria-busy');
    });
  });

  it('exports the five names the design inventory uses', () => {
    render(
      <>
        <InkButton>Ink</InkButton>
        <LimeButton>Lime</LimeButton>
        <OutlineButton>Outline</OutlineButton>
        <TextButton>Text</TextButton>
        <DestructiveButton>Delete</DestructiveButton>
      </>,
    );

    expect(screen.getByRole('button', { name: 'Ink' })).toHaveClass('tm-button--ink');
    expect(screen.getByRole('button', { name: 'Lime' })).toHaveClass('tm-button--lime');
    expect(screen.getByRole('button', { name: 'Outline' })).toHaveClass('tm-button--outline');
    expect(screen.getByRole('button', { name: 'Text' })).toHaveClass('tm-button--text');
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('tm-button--destructive');
  });

  it('has no axe violations in any tone', async () => {
    const { container } = render(
      <>
        <InkButton>Ink</InkButton>
        <LimeButton>Lime</LimeButton>
        <DestructiveButton disabled>Delete</DestructiveButton>
        <Button loading>Publish</Button>
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('OrbButton', () => {
  it('takes its accessible name from the required label, and hides the glyph', () => {
    render(<OrbButton label="Add work item" icon={<svg />} />);
    const button = screen.getByRole('button', { name: 'Add work item' });
    expect(button).toHaveClass('tm-orb-button', 'tm-orb-button--default');
    expect(button.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it.each(['compact', 'default', 'comfortable', 'navigation', 'feature', 'hero'] as const)(
    'renders the %s orb size',
    (size) => {
      render(<OrbButton label={`Orb ${size}`} icon="+" size={size} />);
      expect(screen.getByRole('button', { name: `Orb ${size}` })).toHaveClass(
        `tm-orb-button--${size}`,
      );
    },
  );

  it('has no axe violations', async () => {
    const { container } = render(<OrbButton label="Open the lens" icon="?" tone="ink" />);
    await expectNoAxeViolations(container);
  });
});

describe('SplitCapsuleButton', () => {
  it('exposes two separately reachable controls', async () => {
    const onClick = vi.fn();
    const onSecondary = vi.fn();

    render(
      <SplitCapsuleButton
        label="New work"
        onClick={onClick}
        secondaryLabel="New work options"
        secondaryIcon="⌄"
        onSecondary={onSecondary}
      />,
    );

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'New work' })).toHaveFocus();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'New work options' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(onSecondary).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('disables both halves together', () => {
    render(
      <SplitCapsuleButton
        label="New work"
        secondaryLabel="New work options"
        secondaryIcon="⌄"
        disabled
      />,
    );
    expect(screen.getByRole('button', { name: 'New work' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New work options' })).toBeDisabled();
  });
});
