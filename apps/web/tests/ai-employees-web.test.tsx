import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { AiEmployeesSettingsScreen } from '../src/components/ai-employees/AiEmployeesSettingsScreen';
import { AiProfileScreen } from '../src/components/ai-employees/AiProfileScreen';
import { MembershipProfile } from '../src/components/ai-employees/MembershipProfile';
import {
  aiRowStatus,
  grantableCustomRoles,
  mergeDirectory,
  offeredProjects,
  testFacts,
  testState,
  TEST_WAIT_MS,
} from '../src/components/ai-employees/ai-employee-model';
import { PeopleDirectoryScreen } from '../src/components/screens/PeopleDirectoryScreen';
import type { CustomRoleOption } from '../src/components/people/ChangeRoleDialog';
import {
  AI_CAST_EN,
  AI_NOW,
  aiEmployeesClient,
  aiList,
  aiPeople,
  aiView,
  type AiClientOptions,
} from '../stories/support/ai-employee-fixtures';
import { expectNoAxeViolations } from './axe';

/**
 * Plan 60 slice 60-07, the web screens of AI employees: People (S1/S2), the hire wizard (S3/S4),
 * the AI employee profile (S6) and Settings › AI employees (S8). The client is the stories'
 * fixture (one workspace for both), with every write recorded, so each case proves what the screen
 * sent: the hire carries the projects, a lifecycle step and a settings change carry the version,
 * a switch-off asks first, and a stale version says so.
 */

interface Write {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

function mount(
  ui: (client: ReturnType<typeof aiEmployeesClient>) => ReactElement,
  options: Partial<AiClientOptions> = {},
) {
  const writes: Write[] = [];
  const client = aiEmployeesClient({
    cast: AI_CAST_EN,
    onWrite: (write) => writes.push(write),
    ...options,
  });
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queries.setQueryData(
    ['shell', 'organizations'],
    [{ id: 'o1', slug: 'northstar', name: 'Northstar Studio', role: 'owner' }],
  );
  const view = render(<QueryClientProvider client={queries}>{ui(client)}</QueryClientProvider>);
  return { ...view, writes };
}

const people = (client: ReturnType<typeof aiEmployeesClient>) => (
  <PeopleDirectoryScreen
    organizationSlug="northstar"
    organizationName="Northstar Studio"
    client={client}
  />
);

describe('the AI employee rules (ai-employee-model)', () => {
  it('reads the row status from the lifecycle and the live connections', () => {
    const mat = aiView(AI_CAST_EN);
    expect(aiRowStatus(mat)).toBe('active');
    expect(aiRowStatus({ ...mat, connection: { live: 0, lastCalledAt: null } })).toBe(
      'notConnected',
    );
    expect(aiRowStatus({ ...mat, status: 'paused' })).toBe('paused');
    expect(aiRowStatus({ ...mat, status: 'retired' })).toBe('retired');
  });

  it('merges people and AI employees once each, in name order', () => {
    const list = aiList(AI_CAST_EN);
    const rows = mergeDirectory(aiPeople(AI_CAST_EN), list.aiEmployees, 'en');
    expect(rows.map((row) => row.name)).toEqual([
      'Laila Hassan',
      'Mat',
      'Mona Rashad',
      'Nour',
      'Peter Kamal',
      'Rami',
      'Sara Adel',
      'Youssef Tarek',
    ]);
  });

  it('offers only open projects that are not closed to AI and not chosen', () => {
    const all = [
      { id: 'a', name: 'A', isClient: false },
      { id: 'b', name: 'B', isClient: true },
      { id: 'c', name: 'C', isClient: false },
    ];
    expect(offeredProjects(all, new Set(['b']), ['c']).map((project) => project.id)).toEqual(['a']);
  });

  it('offers a custom role only when every right in it is one the hiring person holds', () => {
    const roles = [
      { id: 'r1', name: 'Writer', capabilities: ['work.read'] },
      { id: 'r2', name: 'Biller', capabilities: ['work.read', 'billing.manage'] },
    ] as unknown as CustomRoleOption[];
    expect(grantableCustomRoles(roles, new Set(['work.read'])).map((role) => role.id)).toEqual([
      'r1',
    ]);
  });

  it('says ready after a call, waiting before, and not called after the wait', () => {
    const since = AI_NOW - 60_000;
    const connected = aiView(AI_CAST_EN, { connection: { live: 1, lastCalledAt: null } });
    const called = aiView(AI_CAST_EN, {
      connection: { live: 1, lastCalledAt: new Date(AI_NOW).toISOString() },
    });
    expect(testState(testFacts(connected, since), 1_000)).toBe('waiting');
    expect(testState(testFacts(connected, since), TEST_WAIT_MS)).toBe('notCalled');
    expect(testState(testFacts(called, since), 1_000)).toBe('ready');
  });
});

describe('People with AI employees (S1, S2)', () => {
  it('counts people and AI employees, filters by tab and names each status, accessibly', async () => {
    const { container } = mount(people);

    expect(await screen.findByText('5 people · 3 AI employees')).toBeTruthy();
    const tabs = screen.getByRole('tablist', { name: 'Show' });
    expect(
      within(tabs)
        .getByRole('tab', { name: /Everyone\s*8/ })
        .getAttribute('aria-selected'),
    ).toBe('true');

    const table = await screen.findByRole('table', { name: 'People in this organization' });
    const nour = within(table).getByText('Nour').closest('tr') as HTMLElement;
    expect(within(nour).getByText('Not connected')).toBeTruthy();
    const rami = within(table).getByText('Rami').closest('tr') as HTMLElement;
    expect(within(rami).getByText('Paused')).toBeTruthy();

    fireEvent.click(within(tabs).getByRole('tab', { name: /AI employees/ }));
    expect(within(table).queryByText('Laila Hassan')).toBeNull();
    expect(within(table).getByText('Mat')).toBeTruthy();
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'tm-aie-people-tab-ai',
    );

    await expectNoAxeViolations(container);
  });

  it('moves between tabs with the arrow keys (APG tabs)', async () => {
    mount(people);
    const everyone = await screen.findByRole('tab', { name: /Everyone/ });
    everyone.focus();
    fireEvent.keyDown(everyone, { key: 'ArrowRight' });
    const peopleTab = screen.getByRole('tab', { name: /^People/ });
    expect(peopleTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(peopleTab);
    fireEvent.keyDown(peopleTab, { key: 'End' });
    expect(screen.getByRole('tab', { name: /AI employees/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('draws no AI tabs or counts when the AI list answers 404, and Add opens the invite', async () => {
    mount(people, { aiOffered: false });
    expect(await screen.findByText('5 people')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('dialog', { name: 'Invite a team member' })).toBeTruthy();
  });

  it('shows the switched-off banner when AI employees are off', async () => {
    mount(people, { scene: 'off' });
    expect(await screen.findByText(/AI employees are switched off\./)).toBeTruthy();
  });

  it('keeps the AI card unavailable at the beta limit and says why (S2b)', async () => {
    mount(people, { scene: 'limit' });
    await screen.findByText('5 people · 5 AI employees');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to your team' });
    const hire = within(dialog).getByRole('radio', {
      name: /Hire an AI employee/,
    }) as HTMLInputElement;
    expect(hire.disabled).toBe(true);
    expect(within(dialog).getByText(/5 of 5 used in the beta/)).toBeTruthy();
  });

  it('pauses an AI employee from his row with his version', async () => {
    const { writes } = mount(people);
    const table = await screen.findByRole('table', { name: 'People in this organization' });
    await within(table).findByText('Mat');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Mat' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Pause' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/v1/organizations/northstar/ai-employees/ai-mat/pause',
      body: { version: 3 },
    });
  });
});

describe('the hire wizard (S3, S4)', () => {
  const wizard = (client: ReturnType<typeof aiEmployeesClient>) => (
    <PeopleDirectoryScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={client}
      initialDialog="hire"
      addressOverride="https://tmanageapp.com/mcp"
    />
  );

  it('asks for a name before Work, and hires once with the projects on leaving Work', async () => {
    const { writes, container } = mount(wizard);
    const dialog = await screen.findByRole('dialog', { name: /Hire an AI employee/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('Give him a name.')).toBeTruthy();
    expect(within(dialog).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mat' } });
    fireEvent.change(within(dialog).getByLabelText('Job title'), {
      target: { value: 'Social media designer' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));

    // Work: choose the client project; the client alert says what he reads.
    const combo = await within(dialog).findByPlaceholderText('Add projects…');
    fireEvent.focus(combo);
    fireEvent.change(combo, { target: { value: 'Nile' } });
    fireEvent.click(await within(dialog).findByRole('option', { name: /Nile Foods social/ }));
    expect(within(dialog).getByText(/is a client project/)).toBeTruthy();
    expect(within(dialog).getByText('2 projects are closed to AI')).toBeTruthy();
    await expectNoAxeViolations(container);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(writes.filter((write) => write.method === 'POST')).toHaveLength(1));
    expect(writes[0]?.path).toBe('/v1/organizations/northstar/ai-employees');
    expect(writes[0]?.body).toMatchObject({
      displayName: 'Mat',
      jobTitle: 'Social media designer',
      role: 'member',
      projectIds: ['p-nile'],
    });
    // Step 3, Connect: the connector address with Copy.
    expect(await within(dialog).findByDisplayValue('https://tmanageapp.com/mcp')).toBeTruthy();
  });
});

describe('the AI employee profile (S6)', () => {
  const profile =
    (
      overrides: Parameters<typeof aiView>[1] = {},
      extra: Partial<Parameters<typeof AiProfileScreen>[0]> = {},
    ) =>
    (client: ReturnType<typeof aiEmployeesClient>) => (
      <AiProfileScreen
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        ai={aiView(AI_CAST_EN, overrides)}
        client={client}
        now={AI_NOW}
        {...extra}
      />
    );

  it('draws the header, About and Projects, with Retire in the menu, accessibly', async () => {
    const { container } = mount(profile());
    expect(screen.getAllByRole('heading', { level: 1, name: 'Mat' })).not.toHaveLength(0);
    expect(screen.getByText('Social media designer · Marketing')).toBeTruthy();
    expect(screen.getByText('Sun–Thu, 9:00–17:00')).toBeTruthy();
    expect(screen.getByText('Nile Foods social')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'More for Mat' }));
    const retire = screen.getByRole('menuitem', { name: 'Retire Mat' });
    expect(retire.closest('li')?.className).toContain('tm-aie-menu__entry--danger');
    await expectNoAxeViolations(container);
  });

  it('asks before a retire and sends the version', async () => {
    const { writes } = mount(profile());
    fireEvent.click(screen.getByRole('button', { name: 'More for Mat' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Retire Mat' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retire Mat?' });
    expect(writes).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retire Mat' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/v1/organizations/northstar/ai-employees/ai-mat/retire',
      body: { version: 3 },
    });
  });

  it('edits the job title in place with the version, and refuses an empty one', async () => {
    const { writes } = mount(profile());
    fireEvent.click(screen.getByRole('button', { name: 'Edit Job title' }));
    const box = screen.getByLabelText('Job title');
    fireEvent.change(box, { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Job title cannot be empty.')).toBeTruthy();
    expect(writes).toHaveLength(0);
    fireEvent.change(box, { target: { value: 'Art director' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PATCH',
      path: '/v1/organizations/northstar/ai-employees/ai-mat',
      body: { jobTitle: 'Art director', version: 3 },
    });
  });

  it('lists connections and revokes a key only after the confirm', async () => {
    const { writes } = mount(profile({}, { initialTab: 'connections' }));
    expect(await screen.findByText('2 of 3 connections')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Connections of Mat' });
    expect(within(table).getByText('Claude connector')).toBeTruthy();
    expect(within(table).getByText('in 58 days')).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: 'Revoke Agent key' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke Agent key?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'DELETE',
      path: '/v1/organizations/northstar/ai-employees/ai-mat/keys/key-1',
    });
  });

  it('shows a rotated key once, with the 24-hour note', async () => {
    mount(profile({}, { initialTab: 'connections' }));
    const table = await screen.findByRole('table', { name: 'Connections of Mat' });
    fireEvent.click(within(table).getByRole('button', { name: 'Rotate Agent key' }));
    const dialog = await screen.findByRole('dialog', { name: 'New key for Mat' });
    expect(within(dialog).getByText(/Copy this key now/)).toBeTruthy();
    expect(within(dialog).getByText(/keeps working for 24 hours/)).toBeTruthy();
  });

  it('offers a new sponsor when he is paused because his sponsor left (S6c)', async () => {
    mount(profile({ status: 'paused', pausedReason: 'sponsor_left' }));
    expect(screen.getByText(/paused because his sponsor left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a sponsor' }));
    expect(await screen.findByLabelText('Sponsor')).toBeTruthy();
  });

  it('draws the none-yet state with Connect (S6g)', async () => {
    mount(profile({ connection: { live: 0, lastCalledAt: null } }, { initialTab: 'connections' }), {
      connections: 'none',
    });
    expect(await screen.findByText('Mat isn’t connected yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('dialog', { name: 'Connect Mat' })).toBeTruthy();
  });

  it('routes an AI membership to the AI profile and any other to the person profile', async () => {
    mount((client) => (
      <MembershipProfile
        organizationSlug="northstar"
        organizationName="Northstar Studio"
        membershipId="m-mat"
        client={client}
      />
    ));
    expect(await screen.findByRole('button', { name: 'More for Mat' })).toBeTruthy();
  });
});

describe('Settings › AI employees (S8)', () => {
  const settings = (client: ReturnType<typeof aiEmployeesClient>) => (
    <AiEmployeesSettingsScreen
      organizationSlug="northstar"
      organizationName="Northstar Studio"
      client={client}
    />
  );

  it('draws the rules, accessibly', async () => {
    const { container } = mount(settings);
    expect(await screen.findByText('3 of 5 used in the beta')).toBeTruthy();
    expect((screen.getByLabelText('Who may hire') as HTMLSelectElement).value).toBe(
      'owners_and_admins',
    );
    expect(await screen.findByText('Payroll 2026')).toBeTruthy();
    expect(await screen.findByText(/Closed by Sara Adel/)).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it('asks before switching AI employees off, then sends the version', async () => {
    const { writes } = mount(settings);
    const toggle = await screen.findByRole('switch', { name: 'AI employees in this workspace' });
    fireEvent.click(toggle);
    const dialog = await screen.findByRole('dialog', { name: 'Switch off AI employees?' });
    expect(writes).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Switch off' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PUT',
      path: '/v1/organizations/northstar/ai-employees/settings',
      body: { enabled: false, version: 4 },
    });
  });

  it('says so when someone else changed the settings first (409)', async () => {
    mount(settings, { failWrites: 409 });
    const select = await screen.findByLabelText('Who may hire');
    await act(async () => {
      fireEvent.change(select, { target: { value: 'owners' } });
    });
    expect(await screen.findByText(/Someone else changed these settings/)).toBeTruthy();
  });

  it('opens a closed project to AI again', async () => {
    const { writes } = mount(settings);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Payroll 2026 to AI again' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      method: 'DELETE',
      path: '/v1/organizations/northstar/ai-employees/excluded-projects/p-payroll',
    });
  });
});
