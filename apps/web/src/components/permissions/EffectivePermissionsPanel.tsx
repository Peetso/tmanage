'use client';

import { CAPABILITIES } from '@tmanage/domain';
import type {
  Capability,
  EffectivePermissionEntry,
  EffectivePermissionsView,
} from '@tmanage/domain';
import { Select } from '@tmanage/ui';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { PermissionMatrix, permissionValueOf } from './PermissionMatrix';
import type { PermissionCellInfo, PermissionCellState } from './PermissionMatrix';
import { capabilityCellLabel, fill } from './RoleMatrixEditor';
import '../../styles/screens/permission-editor.css';

/**
 * platform-admin v2 · PA-04 — "what can this person do" (D8 `439:22016` left column, `439:22713`
 * owner; the B4 drawer and A6 link here too).
 *
 * The read-only matrix of PA-01, each cell coloured by why it is on or off — granted by role,
 * allowed by an override, denied by an override, off by organization policy, not in the role —
 * with the reason sentence on hover. "Simulate on project" re-asks the server for one project
 * (relation-gated cells change). Capabilities the view leaves out (internal-only ones for a
 * client contact) are hidden, not drawn as "no".
 */
export interface EffectivePermissionsPanelProps {
  readonly effective: EffectivePermissionsView;
  readonly projectOptions?: readonly { readonly id: string; readonly name: string }[];
  readonly onSimulate?: (projectId: string | null) => void;
  /** The project currently simulated (`null` = organization level). */
  readonly projectId?: string | null;
  /** The role's name for the reason sentences ("granted by role Owner"). */
  readonly roleName?: string;
  /** The capability the dark explanation card describes; defaults to the first override. */
  readonly explain?: Capability | null;
}

/** The chip a source paints. */
export function cellStateOf(entry: EffectivePermissionEntry): PermissionCellState {
  switch (entry.source) {
    case 'override_allow':
      return entry.final ? 'allow' : 'not_in_ceiling';
    case 'override_deny':
      return 'deny';
    case 'org_policy_off':
      return 'policy_off';
    case 'role':
    case 'custom_role':
      return entry.final ? 'role' : 'not_in_ceiling';
    default:
      return 'not_in_ceiling';
  }
}

const SOURCE_KEY: Readonly<Record<EffectivePermissionEntry['source'], MessageKey>> = {
  role: 'PermissionEditor.reason.role',
  custom_role: 'PermissionEditor.reason.custom_role',
  override_allow: 'PermissionEditor.reason.override_allow',
  override_deny: 'PermissionEditor.reason.override_deny',
  org_policy_off: 'PermissionEditor.reason.org_policy_off',
  not_in_ceiling: 'PermissionEditor.reason.not_in_ceiling',
};

const SCOPE_KEY: Readonly<Record<EffectivePermissionEntry['scope'], MessageKey>> = {
  org: 'PermissionEditor.scopeSentence.org',
  projects: 'PermissionEditor.scopeSentence.projects',
  own: 'PermissionEditor.scopeSentence.own',
};

export function EffectivePermissionsPanel({
  effective,
  projectOptions,
  onSimulate,
  projectId = null,
  roleName = '',
  explain,
}: EffectivePermissionsPanelProps) {
  const t = useT();
  const byCapability = new Map<Capability, EffectivePermissionEntry>(
    effective.map((entry) => [entry.capability, entry]),
  );
  const hidden = CAPABILITIES.filter((capability) => !byCapability.has(capability));
  const value = permissionValueOf(
    effective.filter((entry) => entry.final).map((entry) => entry.capability),
  );
  const reasonOf = (entry: EffectivePermissionEntry) =>
    fill(t(SOURCE_KEY[entry.source]), { role: roleName });
  const cellState = (capability: Capability): PermissionCellInfo | undefined => {
    const entry = byCapability.get(capability);
    if (!entry) return undefined;
    return { state: cellStateOf(entry), reason: reasonOf(entry) };
  };

  const focus =
    (explain ? byCapability.get(explain) : undefined) ??
    effective.find(
      (entry) => entry.source === 'override_allow' || entry.source === 'override_deny',
    );

  return (
    <div className="tm-pe" data-testid="effective-permissions">
      {projectOptions && onSimulate ? (
        <div className="tm-pe__compare">
          <Select
            label={t('PermissionEditor.simulateLabel')}
            value={projectId ?? ''}
            onChange={(event) => onSimulate(event.currentTarget.value || null)}
          >
            <option value="">{t('PermissionEditor.simulateNone')}</option>
            {projectOptions.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <PermissionMatrix
        mode="readonly"
        value={value}
        cellState={cellState}
        hidden={hidden}
        rowAllToggles={false}
        columnAllToggles={false}
        label={t('PermissionEditor.effectiveLabel')}
      />
      {focus ? (
        <div className="tm-pe__explain" data-testid="effective-explain" data-source={focus.source}>
          <p className="tm-cc-card__body" style={{ margin: 0 }}>
            {capabilityCellLabel(t, focus.capability)} — {reasonOf(focus)}.
          </p>
          <p className="tm-pe__explain-sub">{t(SCOPE_KEY[focus.scope])}</p>
        </div>
      ) : null}
    </div>
  );
}
