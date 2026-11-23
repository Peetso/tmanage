import { render, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppShell } from '../src/components/shell/AppShell';
import { expectNoAxeViolations } from './axe';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

/**
 * WX1 (WORK-BUILD-FABLE-REVIEW must-fix 3, 4, 13): the compact header of Work area v2.
 * The bare shell (no query client) is rendered, so the shell's own launchers are the fallback
 * Help link; what is asserted is where things are, not what the launchers do.
 */
function renderCompact(props: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return render(
    <AppShell
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      activeNavigationId="work"
      title="Design the landing page"
      header="compact"
      actions={<button type="button">Send for review</button>}
      {...props}
    >
      <p>Canvas</p>
    </AppShell>,
  );
}

describe('AppShell header="compact"', () => {
  it('draws one header holding the title and the screen’s own controls, nothing of the shell', () => {
    const { container } = renderCompact({ titleMeta: '24 items' });
    const header = container.querySelector('header.tm-compact-header');
    expect(header).not.toBeNull();
    const row = within(header as HTMLElement);
    expect(row.getByRole('heading', { level: 1 }).textContent).toBe('Design the landing page');
    expect(row.getByText('24 items')).toBeTruthy();
    expect(row.getByRole('button', { name: 'Send for review' })).toBeTruthy();
    // Help is reachable, but outside the page header (the rail foot / the phone top bar).
    expect(row.queryByRole('link', { name: /help/i })).toBeNull();
    const tools = container.querySelector('.tm-shell-tools');
    expect(tools).not.toBeNull();
    expect(header?.contains(tools as Node)).toBe(false);
  });

  it('puts the plain trail and its controls in the first row, and a back link for the phone', () => {
    const { container } = renderCompact({
      crumbs: <a href="/northstar/projects/p1">Website relaunch</a>,
      crumbActions: <button type="button">Start timer</button>,
      back: { href: '/northstar/projects/p1', label: 'Website relaunch' },
    });
    const header = container.querySelector('header.tm-compact-header') as HTMLElement;
    expect(header.dataset['trail']).toBe('true');
    const trail = within(header).getByRole('navigation', { name: 'Where you are' });
    expect(within(trail).getByRole('link', { name: 'Website relaunch' })).toBeTruthy();
    const trailRow = header.querySelector('.tm-compact-header__trail-row') as HTMLElement;
    expect(within(trailRow).getByRole('button', { name: 'Start timer' })).toBeTruthy();
    expect(trailRow.querySelector('.tm-compact-header__back')?.getAttribute('href')).toBe(
      '/northstar/projects/p1',
    );
    // The eyebrow line of the standard header (mono capitals with a leading dot) is not drawn.
    expect(container.querySelector('.tm-canvas-header__context')).toBeNull();
  });

  it('keeps the organization line and the header in the column beside the rail', () => {
    const { container } = renderCompact({ contextRail: <a href="/northstar/work">All work</a> });
    // The phone top bar's organization line; the name itself resolves from the session's list.
    expect(container.querySelector('p.tm-compact-org .tm-compact-org__name')).not.toBeNull();
    const columns = container.querySelector('.tm-app__columns[data-layout="compact"]');
    expect(columns?.querySelector(':scope > nav.tm-context-rail')).not.toBeNull();
    expect(columns?.querySelector(':scope > .tm-app__pane > header')).not.toBeNull();
    expect(container.querySelector('.tm-app')?.getAttribute('data-header')).toBe('compact');
  });

  it('marks a header the phone drops when the screen draws its own back link and title', () => {
    const { container } = renderCompact({ phoneHeader: 'hide' });
    expect(container.querySelector('header.tm-compact-header')?.getAttribute('data-phone')).toBe(
      'hidden',
    );
  });

  it('has no axe violations', async () => {
    const { container } = renderCompact({
      crumbs: <a href="/northstar/projects/p1">Website relaunch</a>,
      back: { href: '/northstar/projects/p1', label: 'Website relaunch' },
    });
    await expectNoAxeViolations(container);
  });
});
