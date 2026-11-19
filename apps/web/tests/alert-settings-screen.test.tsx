import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AlertSettingsScreen } from '../src/components/screens/AlertSettingsScreen';
import { mayOpenSection } from '../src/components/admin/ControlCenterShell';
import { ALERTS_DEFAULT, alertsClient, type AlertRoutes } from '../stories/support/alert-fixtures';
import { expectNoAxeViolations } from './axe';

vi.mock('next/navigation', () => ({
  usePathname: () => '/northstar/settings/alerts',
  useRouter: () => ({ push: vi.fn() }),
}));

/**
 * 62-27 (B12) — Settings → Alerts (FIGMA-D group c, fixes 23–32): owner only, each of the eight
 * rule rows drawn from the server's catalogue, money rules told to finance only as fixed text,
 * off dims and disables, thresholds checked against the server's limits, Save offered only after
 * a change, then busy, then the saved toast.
 */

const ALERTS_CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/styles/screens/alert-settings.css'),
  'utf8',
);

function mount(routes: AlertRoutes = {}) {
  const writes: { path: string; body: unknown }[] = [];
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={query}>
      <AlertSettingsScreen
        organizationSlug="northstar"
        organizationName="Atlas Studio"
        client={alertsClient(routes, writes)}
      />
    </QueryClientProvider>,
  );
  return { ...view, writes };
}

const rows = async () => {
  await screen.findByRole('switch', { name: 'Task late or at risk' });
  return screen.getAllByRole('listitem').filter((li) => li.classList.contains('tm-alerts__row'));
};

describe('Settings → Alerts', () => {
  it('draws the eight rules with their meanings, in catalogue order, with no axe violations', async () => {
    const { container } = mount();
    const drawn = await rows();
    expect(drawn).toHaveLength(8);
    expect(
      drawn.map((row) => within(row).getByRole('switch').closest('.tm-choice')?.textContent),
    ).toEqual([
      expect.stringContaining('A task is past due, or due soon with more work left than time'),
      expect.stringContaining('Planned hours go over the person’s capacity'),
      expect.stringContaining('An invoice is still unpaid after its due date'),
      expect.stringContaining('Spending goes over the project budget'),
      expect.stringContaining('An open task has not changed'),
      expect.stringContaining('An expense is far above the usual for its category'),
      expect.stringContaining('A client has not answered an approval'),
      expect.stringContaining('Approved time waits to be invoiced'),
    ]);
    await expectNoAxeViolations(container);
  });

  it('thresholds and units come from the server (approved time not invoiced = 14 days)', async () => {
    mount();
    await rows();
    const box = screen.getByRole('spinbutton', { name: 'Approved time not invoiced, Threshold' });
    expect(box).toHaveValue(14);
    expect(box).toHaveAttribute('min', '1');
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Overloaded person, Threshold' })).toHaveValue(
      110,
    );
    const stale = screen.getByRole('spinbutton', { name: 'Stale task, Threshold' });
    const unit = document.getElementById(stale.getAttribute('aria-describedby') ?? '');
    expect(unit?.textContent).toBe('days');
  });

  it('money rules: "Finance team" as fixed text with the finance sentence, no select', async () => {
    mount();
    const drawn = await rows();
    for (const name of [
      'Overdue invoice',
      'Project over budget',
      'Unusual expense',
      'Approved time not invoiced',
    ]) {
      const row = drawn.find((r) => within(r).queryByRole('switch', { name }) !== null)!;
      expect(within(row).queryByRole('combobox')).toBeNull();
      expect(row.textContent).toContain('Only people with finance access are told.');
    }
    const budget = drawn.find((r) =>
      within(r).queryByRole('switch', { name: 'Project over budget' }),
    )!;
    expect(budget.textContent).toContain('Owner and finance team');
    const select = screen.getByRole('combobox', { name: 'Task late or at risk, Who is told' });
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Project lead', 'Their manager', 'Assignee', 'Owner', 'Project lead and owner']);
  });

  it('a rule that is off keeps its values but dims and disables them; the off sentence is said', async () => {
    mount();
    await rows();
    const unusual = screen.getByRole('switch', { name: 'Unusual expense' });
    expect(unusual).not.toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Unusual expense, Threshold' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'Unusual expense, Threshold' })).toHaveValue(3);
    expect(unusual.closest('li')).toHaveClass('tm-alerts__row--off');
    expect(
      screen.getByText(
        'A rule that is off sends no notices. The business briefing on Home still shows it.',
      ),
    ).toBeInTheDocument();
  });

  it('Save is offered only after a change, checks the limits, then saves and says so', async () => {
    const { writes } = mount();
    await rows();
    const save = screen.getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();

    const stale = screen.getByRole('spinbutton', { name: 'Stale task, Threshold' });
    fireEvent.change(stale, { target: { value: '0' } });
    expect(save).toBeEnabled();
    expect(stale).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText(/Enter a whole number from 1 to/)).toBeInTheDocument();
    fireEvent.click(save);
    expect(writes).toHaveLength(0);
    expect(stale).toHaveFocus();

    fireEvent.change(stale, { target: { value: '21' } });
    fireEvent.click(screen.getByRole('switch', { name: 'Unusual expense' }));
    fireEvent.click(save);
    expect(await screen.findByText('Alert rules saved')).toBeInTheDocument();
    expect(writes).toHaveLength(1);
    const body = writes[0]!.body as {
      rules: { rule: string; enabled: boolean; threshold: number }[];
    };
    expect(body.rules).toHaveLength(8);
    expect(body.rules.find((r) => r.rule === 'stale_task')?.threshold).toBe(21);
    expect(body.rules.find((r) => r.rule === 'unusual_expense')?.enabled).toBe(true);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled(),
    );
  });

  it('Cancel puts back what is saved', async () => {
    mount();
    await rows();
    const stale = screen.getByRole('spinbutton', { name: 'Stale task, Threshold' });
    fireEvent.change(stale, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const saved = ALERTS_DEFAULT.rules.find((r) => r.rule === 'stale_task')!.threshold;
    expect(stale).toHaveValue(saved);
  });

  it('owner only: anyone else is told so and is not given the menu entry', async () => {
    mount({ settings: 403 });
    expect(
      await screen.findByText('Only the company owner can change these rules.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
    const entry = {
      id: 'alerts',
      labelKey: 'x',
      href: '/settings/alerts',
      capability: 'org.manage',
      ownerOnly: true,
    } as const;
    expect(mayOpenSection('org_admin', entry as never)).toBe(false);
    expect(mayOpenSection('owner', entry as never)).toBe(true);
  });

  it('flag off: a calm sentence, no rules', async () => {
    mount({ settings: null });
    expect(
      await screen.findByText('Alerts are not turned on for this company.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('D8: the neutral notes carry Icon/info, not a drawn letter', async () => {
    const { container } = mount();
    await rows();
    const note = screen
      .getByText(/A rule that is off sends no notices/u)
      .closest('.tm-inline-alert');
    expect(note?.querySelector('svg[data-icon="info"]')).not.toBeNull();
    expect(note?.querySelector('[data-glyph]')).toBeNull();
    expect(container.querySelectorAll('.tm-inline-alert [data-glyph="i"]')).toHaveLength(0);
  });

  it('D8: the meaning sits under the name, beside the switch; the threshold column is fixed', () => {
    expect(ALERTS_CSS).toMatch(
      /\.tm-alerts__rule \{[^}]*display: grid;[^}]*grid-template-columns: auto minmax\(0, 1fr\);/u,
    );
    expect(ALERTS_CSS).toMatch(/\.tm-alerts__rule \.tm-choice__row \{[^}]*display: contents;/u);
    expect(ALERTS_CSS).toMatch(
      /\.tm-alerts__rule \.tm-choice__label,\s*\.tm-alerts__rule \.tm-choice__hint \{[^}]*grid-column: 2;/u,
    );
    expect(ALERTS_CSS).toMatch(
      /grid-template-columns: minmax\(0, 1fr\) 200px minmax\(12rem, 14rem\);/u,
    );
  });
});
