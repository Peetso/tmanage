import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocaleDirectionProvider } from '../src/components/providers/LocaleDirectionProvider';
import { PortalMenu } from '../src/components/shell/PortalMenu';
import { PortalProjectSwitcher } from '../src/components/shell/PortalProjectSwitcher';
import { ApiClient } from '../src/lib/api/client';
import { activeLocale } from '../src/lib/i18n/locale-store';

/**
 * The compact portal menu (Figma ph-portal) and the project switcher (fq9). What only this file
 * proves: the menu's items and their order, the approvals count, that choosing a project is a
 * change of `?project=` (the URL is the state), and that the card reads right to left in Arabic.
 */

let search = new URLSearchParams('');
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/northstar/portal/files',
  useSearchParams: () => search,
}));

const PROJECTS = [
  {
    id: 'p1',
    name: 'Website relaunch',
    status: 'active',
    committedAt: null,
    forecastAt: null,
  },
  { id: 'p2', name: 'Brand guidelines', status: 'active', committedAt: null, forecastAt: null },
  { id: 'p3', name: 'Spring campaign', status: 'active', committedAt: null, forecastAt: null },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function api(): ApiClient {
  return new ApiClient({
    baseUrl: 'https://api.example.test',
    csrfCookieName: 'tm_session_csrf',
    fetch: ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/portal/projects')) return Promise.resolve(json({ projects: PROJECTS }));
      if (url.includes('/portal/work-items')) {
        return Promise.resolve(
          json({
            workItems: [
              { id: 'w1', projectId: 'p1', title: 'Homepage', progress: 'waiting_on_you' },
              { id: 'w2', projectId: 'p1', title: 'Footer', progress: 'in_progress' },
            ],
          }),
        );
      }
      return Promise.resolve(json({}));
    }) as typeof globalThis.fetch,
    readCsrfToken: () => 'csrf-token',
    newCorrelationId: () => 'correlation-fixed',
  });
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <LocaleDirectionProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </LocaleDirectionProvider>
  );
}

function renderMenu() {
  render(
    wrap(
      <PortalMenu
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        activeNavigationId="actions"
        client={api()}
      />,
    ),
  );
  // The trigger reads "Menu" in English and "القائمة" in Arabic.
  fireEvent.click(screen.getByRole('button', { name: /Menu|القائمة/ }));
}

afterEach(() => {
  act(() => activeLocale.set('en-US'));
  search = new URLSearchParams('');
  push.mockReset();
});

describe('PortalMenu (ph-portal)', () => {
  it('opens on Menu with the project block, the six destinations, language and sign out', async () => {
    search = new URLSearchParams('project=p1');
    renderMenu();
    expect(await screen.findByText('Website relaunch')).toBeInTheDocument();
    const labels = Array.from(document.querySelectorAll('.tm-portal-menu__label'));
    expect(labels.map((label) => label.textContent)).toEqual([
      'Home',
      'Approvals',
      'Requests',
      'Files',
      'Messages',
      'Chat',
      'العربية',
      'Sign out',
    ]);
    // The chosen project travels with every destination.
    expect(screen.getByRole('link', { name: 'Files' })).toHaveAttribute(
      'href',
      '/northstar/portal/files?project=p1',
    );
    const approvals = screen.getByRole('link', { name: /Approvals/ });
    expect(approvals).toHaveAttribute('aria-current', 'page');
    expect(await within(approvals).findByText('1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'العربية' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    fireEvent.keyDown(approvals, { key: 'Escape' });
    expect(screen.queryByRole('link', { name: 'Home' })).toBeNull();
  });

  it('switches project through the URL: each row sets ?project=, All projects clears it', async () => {
    search = new URLSearchParams('project=p1&tab=recent');
    renderMenu();
    fireEvent.click(await screen.findByRole('button', { name: /Website relaunch/ }));
    expect(screen.getByText('Your projects')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Website relaunch' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('link', { name: 'Brand guidelines' })).toHaveAttribute(
      'href',
      '/northstar/portal/files?project=p2&tab=recent',
    );
    expect(screen.getByRole('link', { name: 'All projects' })).toHaveAttribute(
      'href',
      '/northstar/portal/files?tab=recent',
    );
  });

  it('reads right to left in Arabic and offers English as the language switch', async () => {
    act(() => activeLocale.set('ar-EG'));
    renderMenu();
    expect(document.documentElement).toHaveAttribute('dir', 'rtl');
    expect(screen.getByRole('button', { name: 'English' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(activeLocale.get()).toBe('en-US');
  });
});

describe('PortalProjectSwitcher (fq9, desktop header)', () => {
  it('names the client over "Your projects" and tints the current project', () => {
    render(
      <PortalProjectSwitcher
        organizationSlug="northstar"
        clientName="Atlas Hospitality"
        projects={PROJECTS}
        fallbackProjectName="Spring campaign"
        variant="header"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Spring campaign/ }));
    expect(screen.getByText('Atlas Hospitality')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Spring campaign' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('link', { name: 'All projects' })).not.toHaveAttribute('aria-current');
  });
});
