import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomeBriefingCard } from '../src/components/screens/HomeBriefingCard';
import { briefingReason } from '../src/components/screens/home-briefing-copy';
import { UndoToastHost } from '../src/components/undo/UndoToastHost';
import { activeLocale } from '../src/lib/i18n/locale-store';
import type { BriefingLine } from '../src/lib/api/home-briefing';
import {
  BRIEFING_EMPTY,
  BRIEFING_LEAD,
  BRIEFING_NONE,
  BRIEFING_NOW,
  BRIEFING_OWNER,
  briefingClient,
  type BriefingRoutes,
} from '../stories/support/briefing-fixtures';
import { expectNoAxeViolations } from './axe';

/**
 * 62-A1b (B11) — the Home business briefing card (FIGMA-D group b): one state per test (filled,
 * lead, empty, failed, absent), the lines as links, "and N more", the phone collapse, Hide with
 * Undo, and the Arabic mount with every name and amount isolated.
 */

const windowWithMatchMedia = window as unknown as { matchMedia?: typeof window.matchMedia };
const originalMatchMedia = windowWithMatchMedia.matchMedia;

function phone() {
  windowWithMatchMedia.matchMedia = vi.fn((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
}

function mount(routes: BriefingRoutes = {}) {
  const writes: { path: string; body: unknown }[] = [];
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={query}>
      <HomeBriefingCard
        organizationSlug="northstar"
        client={briefingClient(routes, writes)}
        now={BRIEFING_NOW}
      />
      <UndoToastHost />
    </QueryClientProvider>,
  );
  return { ...view, writes };
}

/** The card once the briefing read has answered (nothing is drawn before). */
function loadedCard(): Promise<HTMLElement> {
  return screen.findByRole('region', { name: 'Business briefing' });
}

afterEach(() => {
  activeLocale.set('en-US');
  if (originalMatchMedia === undefined) delete windowWithMatchMedia.matchMedia;
  else windowWithMatchMedia.matchMedia = originalMatchMedia;
});

describe('HomeBriefingCard', () => {
  it('owner: every group in the drawn order, strong group headings, counts and "as of"', async () => {
    const { container } = mount();
    const card = await loadedCard();
    const groups = within(card).getAllByRole('heading', { level: 3 });
    expect(groups.map((heading) => heading.textContent?.replace(/\d+.*$/u, ''))).toEqual([
      'Projects at risk',
      'Money to collect',
      'People overloaded',
      'Waiting on clients',
      'Over budget',
      'Stale work',
      'Unusual expenses',
    ]);
    expect(within(card).getByText(/^As of .* today$/u)).toBeInTheDocument();
    expect(
      within(card).getByText('What needs you across the company. We check every hour.'),
    ).toBeInTheDocument();
    expect(within(card).getByText('5 in Projects at risk')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it('each line opens its record, with its reason in words; "and N more" opens the list', async () => {
    mount();
    const card = await loadedCard();
    const invoice = within(card).getByRole('link', { name: /INV-0038 · Cedar Foods/u });
    expect(invoice).toHaveAttribute('href', '/northstar/finance/invoices/i-38');
    expect(invoice).toHaveTextContent('$4,200.00, 12 days overdue');
    expect(within(card).getByRole('link', { name: /Logo final v3/u })).toHaveAttribute(
      'href',
      '/northstar/projects/proj-1/deliverables/d-logo',
    );
    expect(within(card).getByRole('link', { name: 'and 2 more' })).toHaveAttribute(
      'href',
      '/northstar/projects/portfolio',
    );
    expect(within(card).getByRole('link', { name: /Omar Adel/u })).toHaveTextContent(
      '115% of their capacity planned this week',
    );
  });

  it('lead: their projects, no money group, the lead sentence', async () => {
    mount({ briefing: BRIEFING_LEAD });
    const card = await loadedCard();
    expect(within(card).queryByText('Money to collect')).not.toBeInTheDocument();
    expect(within(card).queryByText(/INV-/u)).not.toBeInTheDocument();
    expect(
      within(card).getByText('What needs you on your projects. We check every hour.'),
    ).toBeInTheDocument();
  });

  it('empty: the message is the heading, with the time of the last check', async () => {
    mount({ briefing: BRIEFING_EMPTY });
    const card = await loadedCard();
    expect(
      within(card).getByRole('heading', { name: 'Nothing needs you today' }),
    ).toBeInTheDocument();
    expect(within(card).getByText(/Last check at/u)).toBeInTheDocument();
  });

  it('failed: says so inside the card and retries', async () => {
    mount({ briefing: 'fail' });
    const card = await loadedCard();
    expect(await within(card).findByRole('alert')).toHaveTextContent(
      'Could not load the briefing. Try again.',
    );
    expect(within(card).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('draws nothing while the first read is on its way', () => {
    const { container } = mount({ briefing: 'pending' });
    expect(container.querySelector('.tm-brief')).toBeNull();
  });

  it.each([
    ['the flag is off, a client or a guest (404)', null],
    ['someone who leads nothing', BRIEFING_NONE],
  ] as const)('absent when %s', async (_name, briefing) => {
    const { container } = mount({ briefing });
    await waitFor(() => expect(container.querySelector('.tm-brief')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Business briefing' })).toBeNull();
  });

  it('absent when the person hid it in their Home settings', async () => {
    const { container } = mount({ prefs: { order: [], hidden: ['businessBriefing'] } });
    await waitFor(() => expect(container.querySelector('.tm-brief')).toBeNull());
  });

  it('Hide from Home: the card goes, Undo brings it back and writes nothing', async () => {
    const { writes } = mount();
    const card = await loadedCard();
    fireEvent.click(within(card).getByRole('button', { name: 'Hide from Home' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Business briefing' })).toBeNull(),
    );
    const toasts = screen.getByTestId('undo-toasts');
    expect(within(toasts).getByText(/Business briefing hidden from Home/u)).toBeInTheDocument();
    fireEvent.click(within(toasts).getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('region', { name: 'Business briefing' })).toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it('phone: each group shows its header and first line, and opens on tap', async () => {
    phone();
    mount();
    const card = await loadedCard();
    const toggle = within(card).getByRole('button', { name: /Projects at risk/u });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(card).getByRole('link', { name: /Launch kit/u })).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Beta build/u })).toBeNull();
    expect(within(card).queryByRole('link', { name: 'and 2 more' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(card).getByRole('link', { name: /Beta build/u })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'and 2 more' })).toBeInTheDocument();
  });

  it('Arabic: names and amounts are isolated, the card mirrors by logical properties', async () => {
    activeLocale.set('ar-EG');
    const { container } = mount();
    const selector = 'a[href="/northstar/finance/invoices/i-38"]';
    await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
    const invoice = container.querySelector(selector);
    const isolated = [...(invoice?.querySelectorAll('bdi') ?? [])].map((bdi) => bdi.textContent);
    expect(isolated).toEqual(expect.arrayContaining(['INV-0038', 'Cedar Foods']));
    expect(isolated.some((text) => /4[,٬]?200|٤[٬,]?٢٠٠/u.test(text ?? ''))).toBe(true);
  });
});

describe('briefingReason', () => {
  const format = {
    text: (key: string) => key,
    number: (value: number) => String(value),
    money: (minor: number, currency: string) => `${currency} ${String(minor / 100)}`,
  };
  const base = BRIEFING_OWNER.groups[0]!.lines[0]!;
  const reason = (patch: Partial<BriefingLine>) =>
    briefingReason({ ...base, ...patch }, format as never);

  it('a deadline says how near or how late, never a negative number', () => {
    expect(reason({ measure: -3 })).toEqual({
      template: 'HomeBriefing.reason.dueLate',
      values: { days: '3' },
    });
    expect(reason({ measure: -1 }).template).toBe('HomeBriefing.reason.dueLateOne');
    expect(reason({ measure: 0 }).template).toBe('HomeBriefing.reason.dueToday');
    expect(reason({ measure: 1 }).template).toBe('HomeBriefing.reason.dueTomorrow');
    expect(reason({ measure: 4 })).toEqual({
      template: 'HomeBriefing.reason.dueIn',
      values: { days: '4' },
    });
  });

  it('an invoice without an amount says the days only', () => {
    expect(reason({ rule: 'overdue_invoice', amount: null, measure: 9 })).toEqual({
      template: 'HomeBriefing.reason.overdue',
      values: { days: '9' },
    });
  });
});
