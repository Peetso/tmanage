import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  Avatar,
  AvatarOverflow,
  Badge,
  InlineAlert,
  Skeleton,
  StateCapsule,
  StatusDot,
} from '../src/components/index.js';
import { expectNoAxeViolations } from './axe.js';

describe('Avatar', () => {
  it('is an image with the person as its name', () => {
    render(<Avatar name="Nadia Rahman" />);
    expect(screen.getByRole('img', { name: 'Nadia Rahman' })).toBeInTheDocument();
  });

  it('says "client" as well as drawing the violet ring', () => {
    render(<Avatar name="Omar Haddad" audience="client" />);
    expect(screen.getByRole('img', { name: 'Omar Haddad, client' })).toHaveClass(
      'tm-avatar--client',
    );
  });

  it('falls back to initials, and hides them from the reader', () => {
    render(<Avatar name="Nadia Rahman" />);
    const avatar = screen.getByRole('img', { name: 'Nadia Rahman' });
    expect(avatar).toHaveTextContent('NR');
    expect(avatar.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('contributes nothing when the name is already on screen beside it', () => {
    render(
      <span>
        <Avatar name="Nadia Rahman" decorative />
        Nadia Rahman
      </span>,
    );
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('counts the people it is not showing', () => {
    render(<AvatarOverflow count={7} label="7 more people" />);
    const overflow = screen.getByRole('img', { name: '7 more people' });
    expect(overflow).toHaveTextContent('+7');
  });
});

describe('StateCapsule', () => {
  it('always carries a word and a shape, not only a colour', () => {
    render(<StateCapsule state="blocked">Blocked</StateCapsule>);
    const capsule = screen.getByText('Blocked').closest('.tm-state-capsule');
    expect(capsule).toHaveClass('tm-state-capsule--blocked');

    const glyph = capsule?.querySelector('.tm-state-capsule__glyph');
    expect(glyph).not.toBeNull();
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(glyph?.textContent).toBe('✕');
  });

  it('gives each state a different shape, so high contrast does not flatten them', () => {
    render(
      <>
        <StateCapsule state="current">In progress</StateCapsule>
        <StateCapsule state="done">Approved</StateCapsule>
        <StateCapsule state="waiting">Client review</StateCapsule>
        <StateCapsule state="future">Not started</StateCapsule>
        <StateCapsule state="archived">Archived</StateCapsule>
      </>,
    );

    const glyphs = [...document.querySelectorAll('.tm-state-capsule__glyph')].map(
      (node) => node.textContent,
    );
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it('reads as its word alone', () => {
    render(<StateCapsule state="done">Approved</StateCapsule>);
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });
});

describe('StatusDot and Badge', () => {
  it('puts the word beside the dot', () => {
    render(<StatusDot tone="live">Live</StatusDot>);
    const dot = screen.getByText('Live').closest('.tm-status-dot');
    expect(dot).toHaveClass('tm-status-dot--live');
    expect(dot?.querySelector('.tm-status-dot__mark')).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders a version hash in mono, which is what the delivery track needs', () => {
    render(
      <Badge mono>
        <span>v4 · 8f21c0</span>
      </Badge>,
    );
    expect(screen.getByText('v4 · 8f21c0').closest('.tm-badge')).toHaveClass('tm-badge--mono');
  });
});

describe('InlineAlert', () => {
  it('is silent by default — an alert on first paint is not news', () => {
    render(<InlineAlert tone="warning">Two approvals are waiting.</InlineAlert>);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('announces politely when it arrives in response to something', () => {
    render(
      <InlineAlert tone="success" live>
        Version published.
      </InlineAlert>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Version published.');
  });

  it('interrupts only for failure', () => {
    render(
      <InlineAlert tone="danger" live title="Publication blocked">
        A linked object is internal-only.
      </InlineAlert>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Publication blocked');
  });

  it('has no axe violations in any tone', async () => {
    const { container } = render(
      <>
        <InlineAlert>Neutral</InlineAlert>
        <InlineAlert tone="success">Success</InlineAlert>
        <InlineAlert tone="warning">Warning</InlineAlert>
        <InlineAlert tone="danger">Danger</InlineAlert>
        <InlineAlert tone="client">Client</InlineAlert>
      </>,
    );
    await expectNoAxeViolations(container);
  });
});

describe('Skeleton', () => {
  it('is never announced', () => {
    const { container } = render(<Skeleton width="200px" />);
    const skeleton = container.querySelector('.tm-skeleton');
    expect(skeleton).toHaveAttribute('aria-hidden', 'true');
    expect(skeleton).toHaveStyle({ width: '200px' });
  });
});
