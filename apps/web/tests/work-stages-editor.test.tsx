import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ProjectStagesScreen } from '../src/components/work/stages/ProjectStagesScreen';
import { StagesSettingsScreen } from '../src/components/work/stages/StagesSettingsScreen';
import { stagesWorld, type StagesWorld } from '../stories/support/stage-fixtures';
import { expectNoAxeViolations } from './axe';

vi.mock('next/navigation', () => ({
  usePathname: () => '/northstar/settings/stages',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * W-WEB-5 — the stages editor (Figma W7 `937:99028`, W8 `937:100226` / `937:100415`, W9
 * `939:101154`). Each test drives the screen as a person would and asserts on the request the
 * API receives: a rename is a PATCH of that stage, Add stage posts the group's state at the end
 * of the group, Move up sends the whole set's new order, a delete names where the works go, a new
 * set carries its template's stages, and a project points at a set or back at the workspace's.
 */

function mount(ui: (world: StagesWorld) => ReactElement, world = stagesWorld()) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={queries}>{ui(world)}</QueryClientProvider>);
  return { ...view, world, user: userEvent.setup() };
}

const settings = (props: { startNew?: boolean; setId?: string } = {}) =>
  function Settings(world: StagesWorld) {
    return (
      <StagesSettingsScreen
        organizationSlug="northstar"
        organizationName="Atlas Studio"
        client={world.client}
        {...props}
      />
    );
  };

const writes = (world: StagesWorld) => world.calls.filter((call) => call.method !== 'GET');

async function openRowMenu(user: ReturnType<typeof userEvent.setup>, stage: string) {
  await user.click(await screen.findByRole('button', { name: `More for ${stage}` }));
  return screen.getByRole('menu', { name: `More for ${stage}` });
}

describe('Settings → Stages', () => {
  it('opens a set and renames a stage in place', async () => {
    const { user, world } = mount(settings({ setId: 'set-design' }));
    const menu = await openRowMenu(user, 'Ideate');
    await user.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    const box = screen.getByRole('textbox', { name: 'Stage name' });
    await user.clear(box);
    await user.type(box, 'Research{Enter}');
    await waitFor(() =>
      expect(writes(world)).toEqual([
        {
          method: 'PATCH',
          path: '/work/stage-sets/set-design/stages/st-ideate',
          search: '',
          body: { name: 'Research' },
        },
      ]),
    );
    expect(await screen.findByText('Research')).toBeInTheDocument();
  });

  it('refuses a name the set already has before asking the API', async () => {
    const { user, world } = mount(settings({ setId: 'set-design' }));
    await user.click(
      within(await openRowMenu(user, 'Ideate')).getByRole('menuitem', { name: 'Rename' }),
    );
    const box = screen.getByRole('textbox', { name: 'Stage name' });
    await user.clear(box);
    await user.type(box, 'Define{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(/already used here/i);
    expect(writes(world)).toEqual([]);
  });

  it('adds a stage at the end of its group, in that group’s state', async () => {
    const { user, world } = mount(settings({ setId: 'set-design' }));
    const group = (await screen.findByRole('region', { name: 'In progress' })) as HTMLElement;
    await user.click(within(group).getByRole('button', { name: 'Add stage' }));
    await user.type(
      within(group).getByRole('textbox', { name: 'New stage in In progress' }),
      'Build{Enter}',
    );
    await waitFor(() =>
      expect(writes(world)[0]).toMatchObject({
        method: 'POST',
        path: '/work/stage-sets/set-design/stages',
        body: { name: 'Build', stateKey: 'in_progress', position: 4 },
      }),
    );
    expect(await within(group).findByText('Build')).toBeInTheDocument();
  });

  it('moves a stage up inside its group from its menu (the drag handle’s single-pointer path)', async () => {
    const { user, world } = mount(settings({ setId: 'set-design' }));
    await user.click(
      within(await openRowMenu(user, 'Ideate')).getByRole('menuitem', { name: 'Move up' }),
    );
    await waitFor(() =>
      expect(writes(world)[0]).toMatchObject({
        method: 'PUT',
        path: '/work/stage-sets/set-design/stages/order',
        body: {
          stageIds: [
            'st-empathize',
            'st-ideate',
            'st-define',
            'st-prototype',
            'st-test',
            'st-done',
          ],
        },
      }),
    );
    // The first stage of a group cannot climb into the group above.
    const menu = await openRowMenu(user, 'Empathize');
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
  });

  it('asks where the works go before deleting a stage, and sends that stage', async () => {
    const { user, world } = mount(settings({ setId: 'set-design' }));
    await user.click(
      within(await openRowMenu(user, 'Ideate')).getByRole('menuitem', { name: 'Delete' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete the stage Ideate?' });
    const target = within(dialog).getByRole('combobox', {
      name: '3 work items are in this stage. Move them to:',
    });
    expect(target).toHaveValue('st-define');
    await user.selectOptions(target, 'st-prototype');
    await user.click(within(dialog).getByRole('button', { name: 'Move and delete' }));
    await waitFor(() =>
      expect(writes(world)[0]).toMatchObject({
        method: 'DELETE',
        path: '/work/stage-sets/set-design/stages/st-ideate',
        search: '?moveToStageId=st-prototype',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Ideate')).not.toBeInTheDocument();
  });

  it('keeps Delete off, with its reason, for the one Done stage and the last Not started one', async () => {
    const { user } = mount(settings({ setId: 'set-design' }));
    const done = await openRowMenu(user, 'Done');
    expect(within(done).getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
    expect(done).toHaveTextContent('A set needs its one Done stage.');
    await user.keyboard('{Escape}');
    const first = await openRowMenu(user, 'Empathize');
    expect(first).toHaveTextContent('A set needs at least one Not started stage.');
    // Done holds one stage: it offers no Add stage.
    const doneGroup = screen.getByRole('region', { name: 'Done' });
    expect(within(doneGroup).queryByRole('button', { name: 'Add stage' })).not.toBeInTheDocument();
    expect(doneGroup).toHaveTextContent('One Done stage');
  });

  it('says a group with no stage is skipped', async () => {
    mount(settings({ setId: 'set-design' }), stagesWorld({ emptyReview: true }));
    const review = await screen.findByRole('region', { name: 'In review' });
    expect(review).toHaveTextContent('No stage yet. Work skips this group.');
  });

  it('?new=1 opens New stage set; Create sends the Design thinking stages and opens the set', async () => {
    const { user, world } = mount(settings({ startNew: true }));
    const dialog = await screen.findByRole('dialog', { name: 'New stage set' });
    expect(within(dialog).getByRole('radio', { name: /Design thinking/ })).toBeChecked();
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Stage set name' }),
      'Research flow',
    );
    const [create] = within(dialog).getAllByRole('button', { name: 'Create' }).slice(-1);
    await user.click(create!);
    await waitFor(() =>
      expect(writes(world)[0]).toMatchObject({
        method: 'POST',
        path: '/work/stage-sets',
        body: {
          name: 'Research flow',
          stages: [
            { name: 'Empathize', stateKey: 'ready' },
            { name: 'Define', stateKey: 'in_progress' },
            { name: 'Ideate', stateKey: 'in_progress' },
            { name: 'Prototype', stateKey: 'in_progress' },
            { name: 'Test', stateKey: 'internal_review' },
            { name: 'Done', stateKey: 'done' },
          ],
        },
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Research flow' })).toBeInTheDocument();
  });

  it('names a refused write in the editor', async () => {
    const { user } = mount(settings({ setId: 'set-design' }), stagesWorld({ failWrites: 409 }));
    await user.click(
      within(await openRowMenu(user, 'Ideate')).getByRole('menuitem', { name: 'Move down' }),
    );
    expect(await screen.findByText('The change was not saved')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = mount(settings({ setId: 'set-design' }));
    await screen.findByRole('region', { name: 'In progress' });
    await expectNoAxeViolations(container);
  });
});

describe('Project → Stages', () => {
  const project = (world: StagesWorld) => (
    <ProjectStagesScreen
      organizationSlug="northstar"
      organizationName="Atlas Studio"
      projectId="proj-1"
      client={world.client}
    />
  );

  it('shows the project’s own set as its board columns and goes back to the workspace stages', async () => {
    const { user, world } = mount(project);
    expect(
      await screen.findByRole('radio', { name: 'This project has its own stages' }),
    ).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Stage set' })).toHaveValue('set-design');
    const columns = screen.getByRole('list', { name: 'Board columns' });
    expect(
      within(columns)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Empathize', 'Define', 'Ideate', 'Prototype', 'Test', 'Done']);
    expect(screen.getByRole('link', { name: 'Edit this stage set' })).toHaveAttribute(
      'href',
      '/northstar/settings/stages?set=set-design',
    );
    await user.click(screen.getByRole('radio', { name: 'Use the workspace stages' }));
    await waitFor(() =>
      expect(writes(world)[0]).toMatchObject({
        method: 'PUT',
        path: '/projects/proj-1/stage-set',
        body: { stageSetId: null },
      }),
    );
    expect(await screen.findByRole('radio', { name: 'Use the workspace stages' })).toBeChecked();
    expect(screen.getByText(/Simple: To do · In progress · In review · Done/)).toBeInTheDocument();
  });

  it('points the project at another set', async () => {
    const { user, world } = mount(project);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Stage set' }),
      'set-client',
    );
    await waitFor(() =>
      expect(writes(world)[0]).toMatchObject({ body: { stageSetId: 'set-client' } }),
    );
  });
});
