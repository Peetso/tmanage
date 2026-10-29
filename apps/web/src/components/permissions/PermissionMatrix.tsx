'use client';

import { Checkbox, Tooltip, VisuallyHidden } from '@tmanage/ui';
import type { Capability } from '@tmanage/domain';
import { MATRIX_MERGED_CELLS } from '@tmanage/domain';
import { MATRIX, MATRIX_ACTIONS, MATRIX_AREAS } from '../../lib/capability-labels';
import type { MatrixAction, MatrixArea } from '../../lib/capability-labels';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import '../../styles/screens/permission-matrix.css';

/**
 * platform-admin v2 · PA-01 — the permission matrix (Figma D7 `439:19450`, `439:20300`; D8
 * `439:22016`, `439:22713`; B4 drawer `435:18634`).
 *
 * One grid of areas × actions, each cell one capability from the domain `MATRIX`. Two modes:
 *
 * - **edit** (D7, the role editor): a checkbox per cell. A cell outside `ceiling` (what the editor
 *   may give) is locked. A cell that differs from `initial` is tinted lime with a "+" or "–". The
 *   first box of a row ticks the whole row; the column heads can tick a whole column.
 * - **readonly** (D8, "what can this person do"): a chip per cell coloured by `cellState` —
 *   granted by role, allowed by override, denied by override, off by organization policy, or not
 *   in the role.
 *
 * Every cell carries its sentence ("Delete work items") as its accessible name and as the hover
 * tooltip. Cells that share one capability ("= create", projects · view) change together.
 */

/** Why a cell is on or off (readonly), or why it cannot be changed (edit, `locked`). */
export type PermissionCellState =
  'role' | 'allow' | 'deny' | 'policy_off' | 'not_in_ceiling' | 'locked';

export interface PermissionCellInfo {
  readonly state: PermissionCellState;
  /** Extra words for the tooltip and accessible name ("Owners always have every permission"). */
  readonly reason?: string;
}

/** The ticked set as the screens hold it: capability → on. A missing key is off. */
export type PermissionValue = Readonly<Partial<Record<Capability, boolean>>>;

export interface PermissionMatrixProps {
  readonly mode: 'edit' | 'readonly';
  /** The capabilities ticked (edit) or held (readonly). */
  readonly value: PermissionValue;
  /**
   * Why each cell is on or off. Readonly: the chip colour (absent = drawn from `value` as
   * granted by role / not in the role). Edit: `locked` disables the cell with `reason`.
   */
  readonly cellState?: (capability: Capability) => PermissionCellInfo | undefined;
  /** Edit: called with the whole next value and the capabilities that changed. */
  readonly onChange?: (next: Record<Capability, boolean>, changed: readonly Capability[]) => void;
  /** Edit: the capabilities the editor may give; everything else is locked. Absent = no lock. */
  readonly ceiling?: ReadonlySet<Capability> | undefined;
  /** Edit: the saved value, so changed cells are marked "+" / "–". */
  readonly initial?: PermissionValue | undefined;
  /** Capabilities not shown at all (internal-only cells for a client member). */
  readonly hidden?: readonly Capability[] | undefined;
  readonly rowAllToggles: boolean;
  readonly columnAllToggles: boolean;
  /** The table's accessible name. */
  readonly label?: string | undefined;
}

/** The message key of each state (the catalog predates the short state names). */
const STATE_KEY: Readonly<Record<PermissionCellState, MessageKey>> = {
  role: 'PermissionMatrix.state.role' as MessageKey,
  allow: 'PermissionMatrix.state.override_allow' as MessageKey,
  deny: 'PermissionMatrix.state.override_deny' as MessageKey,
  policy_off: 'PermissionMatrix.state.org_policy_off' as MessageKey,
  not_in_ceiling: 'PermissionMatrix.state.not_in_role' as MessageKey,
  locked: 'PermissionMatrix.locked' as MessageKey,
};

/** Every capability the value holds, as a list. */
export function heldCapabilities(value: PermissionValue): Capability[] {
  return (Object.keys(value) as Capability[]).filter((capability) => value[capability] === true);
}

/** A value from a list of held capabilities. */
export function permissionValueOf(capabilities: Iterable<Capability>): Record<Capability, boolean> {
  const out = {} as Record<Capability, boolean>;
  for (const capability of capabilities) out[capability] = true;
  return out;
}

const MERGED: ReadonlySet<string> = new Set(MATRIX_MERGED_CELLS);

const CHIP: Readonly<Record<PermissionCellState, string>> = {
  role: '✓',
  allow: '✓ +',
  deny: '×',
  policy_off: '',
  not_in_ceiling: '·',
  locked: '·',
};

function LockGlyph() {
  return (
    <svg
      className="tm-pm__lock"
      viewBox="0 0 12 12"
      width="12"
      height="12"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" fill="none" stroke="currentColor" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" fill="none" stroke="currentColor" />
    </svg>
  );
}

export function PermissionMatrix({
  mode,
  value,
  cellState,
  onChange,
  ceiling,
  initial,
  hidden,
  rowAllToggles,
  columnAllToggles,
  label,
}: PermissionMatrixProps) {
  const t = useT();
  const held = new Set<Capability>(heldCapabilities(value));
  const hiddenSet = new Set<Capability>(hidden ?? []);
  const ceilingSet = ceiling ?? null;
  const initialSet = initial ? new Set<Capability>(heldCapabilities(initial)) : null;
  const editable = mode === 'edit' && onChange !== undefined;

  const areaName = (area: MatrixArea) => t(`PermissionMatrix.area.${area}` as MessageKey);
  const actionName = (action: MatrixAction) => t(`PermissionMatrix.action.${action}` as MessageKey);
  const sentence = (capability: Capability) =>
    t(`PermissionMatrix.cap.${capability}` as MessageKey);

  const visible = (capability: Capability | null): capability is Capability =>
    capability !== null && !hiddenSet.has(capability);
  const lockedByState = (capability: Capability) =>
    mode === 'edit' && cellState?.(capability)?.state === 'locked';
  const locked = (capability: Capability) =>
    (ceilingSet !== null && !ceilingSet.has(capability)) || lockedByState(capability);

  const commit = (next: Set<Capability>) => {
    const changed = [...new Set<Capability>([...held, ...next])].filter(
      (capability) => held.has(capability) !== next.has(capability),
    );
    onChange?.(permissionValueOf(next), changed);
  };
  const toggle = (capability: Capability, on: boolean) => {
    const next = new Set(held);
    if (on) next.add(capability);
    else next.delete(capability);
    commit(next);
  };
  const toggleMany = (capabilities: readonly Capability[], on: boolean) => {
    const next = new Set(held);
    for (const capability of capabilities) {
      if (locked(capability)) continue;
      if (on) next.add(capability);
      else next.delete(capability);
    }
    commit(next);
  };

  const rowCapabilities = (area: MatrixArea): Capability[] => {
    const out: Capability[] = [];
    for (const action of MATRIX_ACTIONS) {
      const capability = MATRIX[area][action];
      if (visible(capability) && !out.includes(capability)) out.push(capability);
    }
    return out;
  };
  const columnCapabilities = (action: MatrixAction): Capability[] => {
    const out: Capability[] = [];
    for (const area of MATRIX_AREAS) {
      const capability = MATRIX[area][action];
      if (visible(capability) && !out.includes(capability)) out.push(capability);
    }
    return out;
  };
  const groupState = (capabilities: readonly Capability[]) => {
    const on = capabilities.filter((capability) => held.has(capability)).length;
    return { all: capabilities.length > 0 && on === capabilities.length, some: on > 0 };
  };

  const infoOf = (capability: Capability): PermissionCellInfo =>
    cellState?.(capability) ?? { state: held.has(capability) ? 'role' : 'not_in_ceiling' };

  const renderCell = (area: MatrixArea, action: MatrixAction) => {
    const capability = MATRIX[area][action];
    if (!visible(capability)) {
      return (
        <span className="tm-pm__none">
          <span aria-hidden="true">—</span>
          <VisuallyHidden>{t('PermissionMatrix.notAvailable')}</VisuallyHidden>
        </span>
      );
    }
    if (MERGED.has(`${area}.${action}`)) {
      return (
        <Tooltip content={t('PermissionMatrix.sameAsCreateHint')}>
          <span
            className="tm-pm__same"
            // The hint lives in a tooltip, so a keyboard must be able to reach the cell to read it.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
          >
            {t('PermissionMatrix.sameAsCreate')}
          </span>
        </Tooltip>
      );
    }
    const words = sentence(capability);

    if (mode === 'readonly') {
      const { state, reason } = infoOf(capability);
      const why = reason ?? t(STATE_KEY[state]);
      return (
        <Tooltip content={`${words} · ${why}`}>
          <span
            className={`tm-pm__chip tm-pm__chip--${state}`}
            role="img"
            // The reason lives in a tooltip, so a keyboard must be able to reach the chip to read it.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
            aria-label={`${words}: ${why}`}
          >
            {state === 'policy_off' ? t('PermissionMatrix.chipOff') : CHIP[state]}
          </span>
        </Tooltip>
      );
    }

    const isLocked = locked(capability);
    const on = held.has(capability);
    const change =
      initialSet === null || initialSet.has(capability) === on ? null : on ? 'added' : 'removed';
    const lockReason = lockedByState(capability)
      ? (cellState?.(capability)?.reason ?? t('PermissionMatrix.locked'))
      : t('PermissionMatrix.locked');
    const tip = isLocked ? `${words} · ${lockReason}` : words;
    return (
      <Tooltip content={tip}>
        <span
          className={[
            'tm-pm__box',
            change ? `tm-pm__box--${change}` : null,
            isLocked ? 'tm-pm__box--locked' : null,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <Checkbox
            className="tm-pm__check"
            label={<VisuallyHidden>{words}</VisuallyHidden>}
            checked={on}
            disabled={!editable || isLocked}
            onChange={(event) => toggle(capability, event.currentTarget.checked)}
          />
          {change ? (
            <span className="tm-pm__mark" aria-hidden="true">
              {change === 'added' ? '+' : '–'}
            </span>
          ) : null}
          {change ? (
            <VisuallyHidden>{t(`PermissionMatrix.change.${change}` as MessageKey)}</VisuallyHidden>
          ) : null}
          {isLocked ? <LockGlyph /> : null}
        </span>
      </Tooltip>
    );
  };

  return (
    <div className="tm-pm">
      <div className="tm-pm__card">
        <table className="tm-pm__grid">
          <caption>
            <VisuallyHidden>{label ?? t('PermissionMatrix.caption')}</VisuallyHidden>
          </caption>
          <thead>
            <tr>
              <th scope="col" className="tm-pm__head tm-pm__head--area">
                {t('PermissionMatrix.areaHead')}
              </th>
              {MATRIX_ACTIONS.map((action) => {
                const column = columnCapabilities(action);
                const group = groupState(column);
                return (
                  <th key={action} scope="col" className="tm-pm__head">
                    {mode === 'edit' && columnAllToggles && column.length > 0 ? (
                      <Checkbox
                        className="tm-pm__head-toggle"
                        label={actionName(action)}
                        checked={group.all}
                        indeterminate={group.some && !group.all}
                        disabled={!editable}
                        onChange={(event) => toggleMany(column, event.currentTarget.checked)}
                      />
                    ) : (
                      actionName(action)
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {MATRIX_AREAS.map((area) => {
              const row = rowCapabilities(area);
              if (row.length === 0) return null;
              const group = groupState(row);
              return (
                <tr key={area} className="tm-pm__row">
                  <th scope="row" className="tm-pm__area">
                    {mode === 'edit' && rowAllToggles ? (
                      <Checkbox
                        className="tm-pm__row-toggle"
                        label={areaName(area)}
                        checked={group.all}
                        indeterminate={group.some && !group.all}
                        disabled={!editable}
                        onChange={(event) => toggleMany(row, event.currentTarget.checked)}
                      />
                    ) : (
                      areaName(area)
                    )}
                  </th>
                  {MATRIX_ACTIONS.map((action) => (
                    <td key={action} className="tm-pm__cell">
                      {renderCell(area, action)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {mode === 'readonly' ? <PermissionMatrixLegend /> : null}
      <p className="tm-pm__footnote">
        {t('PermissionMatrix.footnote.none')} · {t('PermissionMatrix.footnote.same')}
        {mode === 'edit' && rowAllToggles ? ` · ${t('PermissionMatrix.footnote.row')}` : ''} ·{' '}
        {t('PermissionMatrix.footnote.hover')}
      </p>
    </div>
  );
}

const LEGEND: readonly PermissionCellState[] = [
  'role',
  'allow',
  'deny',
  'policy_off',
  'not_in_ceiling',
];

/** The readonly legend row: one chip per cell state with its words. */
export function PermissionMatrixLegend() {
  const t = useT();
  return (
    <ul className="tm-pm__legend">
      {LEGEND.map((state) => (
        <li key={state} className="tm-pm__legend-item">
          <span className={`tm-pm__chip tm-pm__chip--${state}`} aria-hidden="true">
            {state === 'policy_off' ? t('PermissionMatrix.chipOff') : CHIP[state]}
          </span>
          {t(STATE_KEY[state])}
        </li>
      ))}
    </ul>
  );
}
