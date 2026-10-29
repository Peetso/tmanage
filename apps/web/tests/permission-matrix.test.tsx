import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { Capability } from '@tmanage/domain';
import {
  PermissionMatrix,
  type PermissionCellInfo,
  type PermissionValue,
} from '../src/components/permissions/PermissionMatrix';
import { expectNoAxeViolations } from './axe';

/**
 * platform-admin v2 · PA-01 — the permission matrix (Figma D7 439:19450, D8 439:22016).
 *
 * Edit mode: each cell is a checkbox named by its sentence, a row's first box ticks the whole row,
 * a cell outside the ceiling is locked, and a changed cell is marked. Readonly mode: chips named by
 * the sentence and the reason, with the legend.
 */

function Editor({
  ceiling,
  cellState,
}: {
  ceiling?: ReadonlySet<Capability>;
  cellState?: (capability: Capability) => PermissionCellInfo | undefined;
}) {
  const [value, setValue] = useState<PermissionValue>({ 'work.read': true });
  return (
    <PermissionMatrix
      mode="edit"
      value={value}
      initial={{ 'work.read': true }}
      onChange={setValue}
      ceiling={ceiling}
      {...(cellState ? { cellState } : {})}
      rowAllToggles
      columnAllToggles={false}
    />
  );
}

describe('PermissionMatrix — edit', () => {
  it('ticks one cell and marks it as an unsaved change', () => {
    render(<Editor />);
    const box = screen.getByRole('checkbox', {
      name: 'Delete work items in projects this person is on',
    });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.getByText('Added, not saved yet')).toBeInTheDocument();
  });

  it('the row box ticks every cell of the row', () => {
    render(<Editor />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Docs' }));
    expect(screen.getByRole('checkbox', { name: 'Read docs' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Export docs' })).toBeChecked();
    expect(screen.getAllByText('= create').length).toBeGreaterThan(0);
  });

  it('locks a cell the editor does not hold', () => {
    render(<Editor ceiling={new Set<Capability>(['work.read', 'doc.read'])} />);
    expect(screen.getByRole('checkbox', { name: 'Manage billing and the plan' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Read docs' })).toBeEnabled();
  });

  it('locks a cell the caller marks locked, with its reason', () => {
    render(
      <Editor
        cellState={(capability) =>
          capability === 'doc.read'
            ? { state: 'locked', reason: 'Owners always have every permission' }
            : undefined
        }
      />,
    );
    expect(screen.getByRole('checkbox', { name: 'Read docs' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Export docs' })).toBeEnabled();
  });

  it('has no axe violation jsdom can see', async () => {
    const { container } = render(<Editor />);
    await expectNoAxeViolations(container);
  });
});

describe('PermissionMatrix — readonly', () => {
  it('names each chip by its sentence and reason and shows the legend', () => {
    render(
      <PermissionMatrix
        mode="readonly"
        value={{ 'work.read': true, 'report.export': true }}
        cellState={(capability) =>
          capability === 'report.export'
            ? { state: 'allow' }
            : capability === 'ai.use'
              ? { state: 'policy_off' }
              : undefined
        }
        rowAllToggles={false}
        columnAllToggles={false}
      />,
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByRole('img', { name: 'Export reports: Allowed by override' })).toBeVisible();
    expect(
      screen.getByRole('img', { name: 'Use AI features: Off by organization policy' }),
    ).toBeVisible();
    expect(screen.getAllByText('Denied by override').length).toBeGreaterThan(0);
  });

  it('hides cells it is told to hide', () => {
    render(
      <PermissionMatrix
        mode="readonly"
        value={{}}
        hidden={['billing.view', 'billing.manage']}
        rowAllToggles={false}
        columnAllToggles={false}
      />,
    );
    expect(screen.queryByRole('rowheader', { name: 'Billing' })).toBeNull();
  });
});
