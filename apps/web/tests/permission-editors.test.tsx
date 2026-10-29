import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Capability, EffectivePermissionEntry } from '@tmanage/domain';
import { ApiRequestError } from '../src/lib/api/errors';
import { RoleMatrixEditor, fill, roleDiff } from '../src/components/permissions/RoleMatrixEditor';
import {
  EffectivePermissionsPanel,
  cellStateOf,
} from '../src/components/permissions/EffectivePermissionsPanel';
import {
  MemberOverridesBody,
  endOfDayIso,
  toInputs,
} from '../src/components/permissions/MemberOverridesScreen';
import type { OverrideRow } from '../src/components/permissions/MemberOverridesScreen';
import type { EffectivePermissions } from '../src/lib/api/permission-matrix';

/**
 * platform-admin v2 · PA-04 — the permission editors around PA-01's matrix: the D7 role editor
 * (diff list, 403 escalation banner, unsaved guard) and the D8 overrides body + effective panel.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const DELETE_BOX = 'Delete work items in projects this person is on';

function editor(overrides: Partial<Parameters<typeof RoleMatrixEditor>[0]> = {}) {
  const onSave = vi.fn(() => Promise.resolve());
  render(
    <RoleMatrixEditor
      role={{
        id: 'r1',
        name: 'Delivery lead',
        builtIn: false,
        capabilities: ['work.read'],
        holders: 6,
      }}
      builtInRoles={[
        { id: 'member', kind: 'internal', capabilities: ['work.read', 'work.create'] },
      ]}
      withReason
      saving={false}
      saveError={null}
      onSave={onSave}
      dialog={null}
      onDialogClose={() => undefined}
      {...overrides}
    />,
  );
  return onSave;
}

function entry(
  capability: Capability,
  source: EffectivePermissionEntry['source'],
  final: boolean,
): EffectivePermissionEntry {
  return { capability, source, final, scope: 'org' } as EffectivePermissionEntry;
}

describe('RoleMatrixEditor (D7)', () => {
  it('lists the change against the saved role and saves the new set', () => {
    const onSave = editor();
    const save = screen.getByRole('button', { name: 'Save role' });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: DELETE_BOX }));
    expect(screen.getByText('1 unsaved change')).toBeInTheDocument();
    expect(screen.getAllByText(/Work items · delete/).length).toBeGreaterThan(0);
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(['work.read', 'work.delete'], '');
  });

  it('shows the escalation banner on a 403 and keeps the refused change', () => {
    editor({
      saveError: new ApiRequestError(403, 'forbidden', 'Forbidden', 'correlation-fixed'),
    });
    expect(screen.getByText('Nothing was saved')).toBeInTheDocument();
  });

  it('holds an in-app link while there are unsaved changes', () => {
    render(<a href="/elsewhere">Away</a>);
    editor();
    fireEvent.click(screen.getByRole('checkbox', { name: DELETE_BOX }));
    fireEvent.click(screen.getByText('Away'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Leave without saving?')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard and leave' }));
    expect(push).toHaveBeenCalledWith('/elsewhere');
  });

  it('opens a built-in role read only', () => {
    editor({
      role: {
        id: 'member',
        name: 'Member',
        builtIn: true,
        capabilities: ['work.read'],
        holders: 3,
      },
    });
    expect(screen.queryByRole('checkbox', { name: DELETE_BOX })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save role' })).toBeNull();
  });

  it('helpers: fill and roleDiff', () => {
    expect(fill('{count} of {total}', { count: 3, total: 54 })).toBe('3 of 54');
    expect(roleDiff(['work.read', 'conversation.read'], ['work.read', 'work.delete'])).toEqual({
      added: ['work.delete'],
      removed: ['conversation.read'],
    });
  });
});

describe('EffectivePermissionsPanel (D8 left column)', () => {
  it('colours each cell by why and hides what the view leaves out', () => {
    expect(cellStateOf(entry('work.read', 'role', true))).toBe('role');
    expect(cellStateOf(entry('work.delete', 'override_allow', true))).toBe('allow');
    expect(cellStateOf(entry('conversation.write', 'override_deny', false))).toBe('deny');
    expect(cellStateOf(entry('ai.use', 'org_policy_off', false))).toBe('policy_off');
    expect(cellStateOf(entry('billing.manage', 'not_in_ceiling', false))).toBe('not_in_ceiling');

    render(
      <EffectivePermissionsPanel
        effective={[
          entry('work.read', 'role', true),
          entry('conversation.write', 'override_deny', false),
        ]}
        roleName="Member"
      />,
    );
    expect(screen.getByTestId('effective-explain')).toHaveAttribute('data-source', 'override_deny');
    expect(screen.queryByLabelText(/Manage billing/)).toBeNull();
  });
});

function effective(): EffectivePermissions {
  return {
    membershipId: 'm1',
    role: 'member',
    projectId: null,
    overrides: { allow: [], deny: [] } as never,
    permissions: [entry('work.read', 'role', true)],
  };
}

describe('MemberOverridesBody (D8)', () => {
  const live: OverrideRow = {
    id: 'o1',
    capability: 'work.delete',
    effect: 'allow',
    reason: 'cover',
    expiresAt: null,
    createdByName: 'Peter',
    live: true,
  };
  const expired: OverrideRow = { ...live, id: 'o2', capability: 'docs.write', live: false };

  it('drops expired rows on save and adds a deny', () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <MemberOverridesBody
        person={{
          displayName: 'Mona',
          roleName: 'member',
          custom: false,
          scope: 'projects',
          kind: 'internal',
          isOwner: false,
        }}
        overrides={[live, expired]}
        effective={effective()}
        projectOptions={[]}
        projectId={null}
        onSimulate={() => undefined}
        withReason={false}
        saving={false}
        saveError={null}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText('Permission'), {
      target: { value: 'conversation.write' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add override' }).at(-1)!);
    fireEvent.click(screen.getByRole('button', { name: 'Save overrides' }));
    expect(onSave).toHaveBeenCalledWith(
      [
        { capability: 'work.delete', effect: 'allow', reason: 'cover', expiresAt: null },
        { capability: 'conversation.write', effect: 'deny', reason: null, expiresAt: null },
      ],
      '',
    );
  });

  it('an owner takes no overrides', () => {
    render(
      <MemberOverridesBody
        person={{
          displayName: 'Peter',
          roleName: 'owner',
          custom: false,
          scope: 'org',
          kind: 'internal',
          isOwner: true,
        }}
        overrides={[]}
        effective={effective()}
        projectOptions={[]}
        projectId={null}
        onSimulate={() => undefined}
        withReason={false}
        saving={false}
        saveError={null}
        onSave={() => Promise.resolve()}
      />,
    );
    expect(screen.getByText('Owners always have every permission')).toBeInTheDocument();
    expect(screen.getByLabelText('Permission')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save overrides' })).toBeDisabled();
  });

  it('helpers: toInputs and endOfDayIso', () => {
    expect(toInputs([live, expired])).toHaveLength(1);
    expect(endOfDayIso('nope')).toBeNull();
    expect(endOfDayIso('2026-11-30')).toMatch(/^2026-1[12]-/);
  });
});
