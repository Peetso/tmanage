import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  EmptyState,
  ForbiddenState,
  LoadingState,
  NotFoundState,
  ServerErrorState,
} from '../src/components/state/StateScreens';
import { STATE_COPY, type StateKey } from '../src/components/state/state-copy';
import { expectNoAxeViolations } from './axe';

/**
 * **The standard platform-state matrix says the same thing everywhere, and every state view is
 * reachable, labelled and — where it acts — focused.**
 *
 * `38-MODULE-MAP` §Platform states asks for one consistent set of state views (403, 404, 500,
 * empty, loading). The audit found it partial: each screen improvised its own. These tests pin
 * the three things that make the set worth sharing — the copy is one map, each view is an axe
 * clean labelled region, and the states that carry a single action land focus on it — with one
 * case per behaviour rather than a case per prop.
 */

const ACTIONABLE: readonly StateKey[] = ['forbidden', 'notFound', 'serverError'];

describe('STATE_COPY is complete', () => {
  it('gives every state in the matrix a title and a description', () => {
    const keys: readonly StateKey[] = ['forbidden', 'notFound', 'serverError', 'empty', 'loading'];
    for (const key of keys) {
      expect(STATE_COPY[key].title.length).toBeGreaterThan(0);
      expect(STATE_COPY[key].description.length).toBeGreaterThan(0);
    }
  });

  it('gives the acting states a label and leaves empty and loading without one', () => {
    for (const key of ACTIONABLE) {
      expect(STATE_COPY[key].action).toBeTruthy();
    }
    expect(STATE_COPY.empty.action).toBeUndefined();
    expect(STATE_COPY.loading.action).toBeUndefined();
  });

  it('offers no support channel this product does not have', () => {
    for (const copy of Object.values(STATE_COPY)) {
      const text = `${copy.title} ${copy.description}`;
      expect(text).not.toMatch(/support@|help@|@tmanage\.(com|io|app)/i);
      expect(text).not.toMatch(/\+\d[\d\s()-]{7,}/);
      expect(text).not.toMatch(/within \d+ (hour|day|business)/i);
    }
  });
});

describe('each state renders its shared copy', () => {
  it('403 forbidden', () => {
    render(<ForbiddenState />);
    expect(screen.getByRole('heading', { name: STATE_COPY.forbidden.title })).toBeInTheDocument();
    expect(screen.getByText(STATE_COPY.forbidden.description)).toBeInTheDocument();
  });

  it('404 not found', () => {
    render(<NotFoundState />);
    expect(screen.getByRole('heading', { name: STATE_COPY.notFound.title })).toBeInTheDocument();
    expect(screen.getByText(STATE_COPY.notFound.description)).toBeInTheDocument();
  });

  it('500 server error', () => {
    render(<ServerErrorState onRetry={() => {}} />);
    expect(screen.getByRole('heading', { name: STATE_COPY.serverError.title })).toBeInTheDocument();
    expect(screen.getByText(STATE_COPY.serverError.description)).toBeInTheDocument();
  });

  it('empty', () => {
    render(<EmptyState />);
    expect(screen.getByRole('heading', { name: STATE_COPY.empty.title })).toBeInTheDocument();
    expect(screen.getByText(STATE_COPY.empty.description)).toBeInTheDocument();
  });

  it('loading, and marks the region busy for assistive tech', () => {
    render(<LoadingState />);
    const region = screen.getByRole('region', { name: STATE_COPY.loading.title });
    expect(region).toHaveAttribute('aria-busy', 'true');
  });
});

describe('the acting states land focus on their one action', () => {
  it('403 focuses the way out', () => {
    render(<ForbiddenState />);
    expect(screen.getByRole('link', { name: STATE_COPY.forbidden.action! })).toHaveFocus();
  });

  it('404 focuses the way out', () => {
    render(<NotFoundState />);
    expect(screen.getByRole('link', { name: STATE_COPY.notFound.action! })).toHaveFocus();
  });

  it('500 focuses the retry, and the retry runs the handler', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ServerErrorState onRetry={onRetry} />);

    const retry = screen.getByRole('button', { name: STATE_COPY.serverError.action! });
    expect(retry).toHaveFocus();
    await user.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus when asked not to', () => {
    render(<ForbiddenState autoFocusAction={false} />);
    expect(screen.getByRole('link', { name: STATE_COPY.forbidden.action! })).not.toHaveFocus();
  });

  it('never invents an action for the empty state, leaving the screen to supply one', () => {
    const { rerender } = render(<EmptyState />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();

    rerender(<EmptyState action={<a href="/x/new">Create the first project</a>} />);
    expect(screen.getByRole('link', { name: 'Create the first project' })).toBeInTheDocument();
  });
});

describe('every state view is axe clean', () => {
  it('403', async () => {
    const { container } = render(<ForbiddenState autoFocusAction={false} />);
    await expectNoAxeViolations(container);
  });

  it('404', async () => {
    const { container } = render(<NotFoundState autoFocusAction={false} />);
    await expectNoAxeViolations(container);
  });

  it('500', async () => {
    const { container } = render(<ServerErrorState onRetry={() => {}} autoFocusAction={false} />);
    await expectNoAxeViolations(container);
  });

  it('empty', async () => {
    const { container } = render(<EmptyState />);
    await expectNoAxeViolations(container);
  });

  it('loading', async () => {
    const { container } = render(<LoadingState />);
    await expectNoAxeViolations(container);
  });
});
