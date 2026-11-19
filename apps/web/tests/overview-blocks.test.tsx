import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewBlocks } from '../src/components/overview/OverviewBlocks';
import { projectOverviewModel } from '../src/components/overview/project-overview-model';
import { clientOverviewModel } from '../src/components/overview/client-overview-model';
import type { OverviewModel } from '../src/components/overview/overview-model';
import { activeLocale } from '../src/lib/i18n/locale-store';
import {
  CLIENT_SUMMARY,
  OVERVIEW_NOW,
  PROJECT_SUMMARY,
  PROJECT_SUMMARY_EMPTY,
  PROJECT_SUMMARY_NO_FINANCE,
} from '../stories/support/overview-fixtures';
import { expectNoAxeViolations } from './axe';

/**
 * ONEPAGE (B04) — each of the six blocks in its three states: filled, empty (the card stays with
 * one calm line, review FIGMA-C fix 7) and absent (no card and no gap, frame 739:41403); the
 * loading and failed page; axe; and the Arabic, right-to-left mount.
 */
const FULL = projectOverviewModel(PROJECT_SUMMARY, 'northstar', OVERVIEW_NOW);
const EMPTY = projectOverviewModel(PROJECT_SUMMARY_EMPTY, 'northstar', OVERVIEW_NOW);

function mount(model: OverviewModel) {
  return render(
    <main>
      <OverviewBlocks state="ready" model={model} now={OVERVIEW_NOW} deliveryEmpty="work" />
    </main>,
  );
}

function card(name: string) {
  return screen.getByRole('region', { name });
}

const BLOCKS = [
  { key: 'delivery', name: 'Delivery', empty: 'No work in this yet.', link: 'Open work' },
  {
    key: 'approvals',
    name: 'Approvals waiting',
    empty: 'No approvals waiting.',
    link: 'Open approvals',
  },
  { key: 'risks', name: 'Risks', empty: 'No risks right now.', link: 'Open health' },
  { key: 'files', name: 'Latest files', empty: 'No files yet.', link: 'Open files' },
  { key: 'time', name: 'Time', empty: 'No time logged yet.', link: 'Open timesheets' },
  { key: 'money', name: 'Money', empty: 'No invoices yet.', link: 'Open invoices' },
] as const;

afterEach(() => activeLocale.set('en-US'));

describe('the six overview blocks', () => {
  it.each(BLOCKS)('$name: filled, with its link to the full screen', ({ name, empty, link }) => {
    mount(FULL);
    const region = card(name);
    expect(within(region).queryByText(empty)).not.toBeInTheDocument();
    expect(within(region).getByRole('link', { name: link })).toHaveAttribute('href');
  });

  it.each(BLOCKS)('$name: empty keeps the card with one calm line', ({ name, empty }) => {
    mount(EMPTY);
    expect(within(card(name)).getByText(empty)).toBeInTheDocument();
  });

  it.each(BLOCKS)('$name: absent draws no card', ({ key, name }) => {
    const { [key]: _gone, ...rest } = FULL;
    const { container } = mount(rest);
    expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    expect(container.querySelectorAll('.tm-ov-card')).toHaveLength(5);
  });

  it('draws the figures and rows the frames show', () => {
    mount(FULL);
    const delivery = card('Delivery');
    expect(within(delivery).getByText('Late').nextElementSibling).toHaveTextContent('3');
    expect(within(delivery).getByRole('link', { name: 'Packaging artwork' })).toHaveAttribute(
      'href',
      '/northstar/projects/proj-1/milestones',
    );
    expect(within(delivery).getByText('At risk')).toBeInTheDocument();

    const approvals = card('Approvals waiting');
    expect(within(approvals).getAllByText('With client')).toHaveLength(2);
    expect(within(approvals).getByText('With team')).toBeInTheDocument();

    const risks = card('Risks');
    expect(within(risks).getByText('3 items are past their due date')).toBeInTheDocument();
    expect(within(risks).getByText('82 % of the budget used')).toBeInTheDocument();
    // D10: the title sits in its own isolate inside the sentence.
    expect(within(risks).getByText('Label artwork v3').tagName).toBe('BDI');
    expect(within(risks).getByText('Label artwork v3').parentElement).toHaveTextContent(
      'Oldest: Label artwork v3',
    );
    expect(within(risks).getAllByText('Late')).toHaveLength(1);

    const time = card('Time');
    expect(within(time).getByText('126 h')).toBeInTheDocument();
    expect(within(time).getByText('Not invoiced yet')).toBeInTheDocument();

    const money = card('Money');
    expect(within(money).getByText('Invoiced · AED').nextElementSibling).toHaveTextContent(
      '48,000',
    );
  });

  it('without finance: the files and time cards share the row, no money figure anywhere', () => {
    const { container } = mount(
      projectOverviewModel(PROJECT_SUMMARY_NO_FINANCE, 'northstar', OVERVIEW_NOW),
    );
    const rows = container.querySelectorAll('.tm-ov-blocks__row');
    expect(rows).toHaveLength(2);
    expect(rows[1]?.children).toHaveLength(2);
    expect(screen.queryByText(/Not invoiced yet/)).not.toBeInTheDocument();
    expect(screen.queryByText(/of the budget used/)).not.toBeInTheDocument();
  });

  it('draws no row at all when a whole row is absent', () => {
    const { container } = mount({ delivery: FULL.delivery! });
    expect(container.querySelectorAll('.tm-ov-blocks__row')).toHaveLength(1);
  });

  it('shows a skeleton per card while loading, and one retry card when the read fails', () => {
    const loading = render(<OverviewBlocks state="loading" />);
    expect(loading.container.querySelectorAll('.tm-ov-card--skeleton')).toHaveLength(6);
    loading.unmount();

    const retry = vi.fn();
    render(<OverviewBlocks state="error" onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this. Try again.');
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('draws the client page from the same blocks', () => {
    mount(clientOverviewModel(CLIENT_SUMMARY, 'northstar', OVERVIEW_NOW));
    expect(
      within(card('Risks')).getByRole('link', { name: 'See projects at risk' }),
    ).toHaveAttribute('href', '/northstar/clients/co-cedar?view=projects&health=at-risk');
    // D7: the line says why (the heaviest health signal), never "Project health is red".
    const behind = within(card('Risks')).getByRole('link', {
      name: 'Ramadan campaign 2027 is behind',
    });
    expect(behind.closest('li')).toHaveTextContent('2 milestones are overdue');
    expect(within(card('Risks')).getByText('One high risk is open')).toBeInTheDocument();
    expect(card('Risks')).not.toHaveTextContent(/health is/);
    // D7: Time shows the three figures and one line per project.
    const time = card('Time');
    for (const label of ['Logged', 'Billable', 'Not invoiced yet']) {
      expect(within(time).getByText(label)).toBeInTheDocument();
    }
    expect(
      within(time).getByRole('link', { name: 'Cedar Foods brand refresh' }).closest('li'),
    ).toHaveTextContent('120 h');
    expect(within(card('Money')).getByText('Overdue · AED').nextElementSibling).toHaveAttribute(
      'data-tone',
      'danger',
    );
  });

  it('has no axe violations, filled and empty', async () => {
    const filled = mount(FULL);
    await expectNoAxeViolations(filled.container);
    filled.unmount();
    const empty = mount(EMPTY);
    await expectNoAxeViolations(empty.container);
  });

  it('mounts right to left in Arabic with the locale’s digits and names kept in their direction', () => {
    activeLocale.set('ar-EG');
    const { container } = render(
      <main dir="rtl">
        <OverviewBlocks state="ready" model={FULL} now={OVERVIEW_NOW} deliveryEmpty="work" />
      </main>,
    );
    const figures = [...container.querySelectorAll('.tm-ov-figures__value')].map(
      (node) => node.textContent,
    );
    expect(figures[0]).toBe(new Intl.NumberFormat('ar-EG').format(18));
    for (const title of container.querySelectorAll('.tm-ov-row__title')) {
      expect(title.getAttribute('dir')).toBe('auto');
    }
  });

  it('styles with logical properties only, so the Arabic frames mirror without a second rule', () => {
    const css = readFileSync(
      join(process.cwd(), 'src', 'styles', 'screens', 'overview.css'),
      'utf8',
    );
    expect(css).not.toMatch(
      /(margin|padding|border)-(left|right)|(left|right)\s*:|text-align:\s*(left|right)/,
    );
  });
});
