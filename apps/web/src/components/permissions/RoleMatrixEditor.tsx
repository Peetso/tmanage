'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Field, InlineAlert, Select, Switch } from '@tmanage/ui';
import { CAPABILITIES, capabilityCell } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiRequestError } from '../../lib/api/errors';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';
import { PlatformDialog, PlatformDialogActions } from '../platform/shared/ReasonDialog';
import { PermissionMatrix, heldCapabilities, permissionValueOf } from './PermissionMatrix';
import type { PermissionValue } from './PermissionMatrix';
import { UnsavedChangesGuard } from './UnsavedChangesGuard';
import '../../styles/screens/permission-editor.css';

/**
 * platform-admin v2 · PA-04 — D7 role matrix editor (Figma `439:19450` platform side,
 * `439:20300` org side with ceiling locks + the 403 escalation banner, `439:21130` guard).
 *
 * One body for both sides; the page owns the shell (title, "Clone role" / "Delete role") and the
 * API calls. Above the grid: "Compare with a built-in role" and the unsaved-change count. Beside
 * it: the diff list against the saved role with Save / Discard, and the built-in roles for
 * reference (open one to see its matrix, read only). Leaving with unsaved changes asks first.
 */

type T = ReturnType<typeof useT>;

/** `{name}` placeholders in a catalog sentence. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** "Work items · delete" — the cell a capability is drawn in. */
export function capabilityCellLabel(t: T, capability: Capability): string {
  const cell = capabilityCell(capability);
  if (cell === null) return capability;
  const area = t(`PermissionMatrix.area.${cell.area}` as MessageKey);
  const action = t(`PermissionMatrix.action.${cell.action}` as MessageKey).toLocaleLowerCase();
  return `${area} · ${action}`;
}

const BUILT_IN_ROLE_IDS = [
  'owner',
  'org_admin',
  'workspace_admin',
  'manager',
  'moderator',
  'member',
  'guest',
  'client_admin',
  'client_reviewer',
  'client_member',
  'client_viewer',
] as const;

/** A built-in role's name ("Org admin"), or the id when the catalog has none. */
export function roleLabel(t: T, role: string): string {
  return (BUILT_IN_ROLE_IDS as readonly string[]).includes(role)
    ? t(`PermissionEditor.role.${role}` as MessageKey)
    : role;
}

/** The ids of a custom role the delete marked retired (see `permissions.repository.ts`). */
export function isRetiredRoleName(name: string): boolean {
  return name.startsWith('†deleted:');
}

export interface RoleDiff {
  readonly added: readonly Capability[];
  readonly removed: readonly Capability[];
}

/** What changed against the saved set, in catalog order. */
export function roleDiff(saved: Iterable<Capability>, next: Iterable<Capability>): RoleDiff {
  const was = new Set(saved);
  const now = new Set(next);
  return {
    added: CAPABILITIES.filter((capability) => now.has(capability) && !was.has(capability)),
    removed: CAPABILITIES.filter((capability) => was.has(capability) && !now.has(capability)),
  };
}

/** "+ Work items · delete" lines for the guard dialog. */
export function diffLines(t: T, diff: RoleDiff): string[] {
  return [
    ...diff.added.map((capability) => `+ ${capabilityCellLabel(t, capability)}`),
    ...diff.removed.map((capability) => `− ${capabilityCellLabel(t, capability)}`),
  ];
}

export interface EditorRole {
  readonly id: string;
  readonly name: string;
  readonly builtIn: boolean;
  readonly capabilities: readonly Capability[];
  /** People holding the role; `null` when the side cannot count them. */
  readonly holders: number | null;
}

export interface BuiltInRoleRef {
  readonly id: string;
  readonly kind: 'internal' | 'client';
  readonly capabilities: readonly Capability[];
}

export type RoleEditorDialog = 'clone' | 'delete' | null;

export interface RoleMatrixEditorProps {
  readonly role: EditorRole;
  readonly builtInRoles: readonly BuiltInRoleRef[];
  /** What the editor may give (org side: the caller's own permissions). Absent = no lock. */
  readonly ceiling?: ReadonlySet<Capability> | undefined;
  /** Show the optional reason field (the platform side records it). */
  readonly withReason: boolean;
  readonly saving: boolean;
  readonly saveError: unknown;
  readonly onSave: (capabilities: readonly Capability[], reason: string) => Promise<unknown>;
  readonly dialog: RoleEditorDialog;
  readonly onDialogClose: () => void;
  readonly onClone?: (name: string) => Promise<unknown>;
  readonly onDelete?: (reassignTo: string) => Promise<unknown>;
  /** Roles the holders may move to on delete. */
  readonly reassignOptions?: readonly { readonly id: string; readonly label: string }[];
}

function describeError(error: unknown, t: T): string {
  if (error instanceof ApiRequestError) return error.message;
  return t('PermissionEditor.errorGeneric');
}

export function RoleMatrixEditor({
  role,
  builtInRoles,
  ceiling,
  withReason,
  saving,
  saveError,
  onSave,
  dialog,
  onDialogClose,
  onClone,
  onDelete,
  reassignOptions = [],
}: RoleMatrixEditorProps) {
  const t = useT();
  const saved = useMemo(() => permissionValueOf(role.capabilities), [role.capabilities]);
  const [value, setValue] = useState<PermissionValue>(saved);
  const [reason, setReason] = useState('');
  const [compareWith, setCompareWith] = useState('');
  const [showKeys, setShowKeys] = useState(true);
  const [viewing, setViewing] = useState<BuiltInRoleRef | null>(null);
  const [refused, setRefused] = useState<readonly Capability[]>([]);
  const [refusedKey, setRefusedKey] = useState('');
  const valueKey = heldCapabilities(value).sort().join(',');

  // A new saved copy (after Save, or another role) starts the edit again.
  useEffect(() => {
    setValue(saved);
    setReason('');
  }, [saved]);

  const diff = roleDiff(heldCapabilities(saved), heldCapabilities(value));
  const changeCount = diff.added.length + diff.removed.length;
  const dirty = changeCount > 0 && !role.builtIn;
  const escalation =
    saveError instanceof ApiRequestError && saveError.status === 403 ? saveError : null;

  // The capabilities the 403 was about: the added ones outside the ceiling, when it is known.
  useEffect(() => {
    if (escalation === null) {
      setRefused([]);
      setRefusedKey('');
      return;
    }
    setRefused(ceiling ? diff.added.filter((capability) => !ceiling.has(capability)) : diff.added);
    setRefusedKey(valueKey);
    // Only when a new refusal arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escalation]);

  const compared = builtInRoles.find((entry) => entry.id === compareWith) ?? null;
  const compareDiff = compared ? roleDiff(heldCapabilities(value), compared.capabilities) : null;

  return (
    <div className="tm-pe">
      <div className="tm-pe__toolbar">
        <div className="tm-pe__compare">
          <Select
            label={t('PermissionEditor.compareLabel')}
            value={compareWith}
            onChange={(event) => setCompareWith(event.currentTarget.value)}
          >
            <option value="">{t('PermissionEditor.compareNone')}</option>
            {builtInRoles
              .filter((entry) => entry.kind === 'internal')
              .map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {roleLabel(t, entry.id)}
                </option>
              ))}
          </Select>
        </div>
        <Switch
          label={t('PermissionEditor.showKeys')}
          checked={showKeys}
          onChange={(event) => setShowKeys(event.currentTarget.checked)}
        />
        {dirty ? (
          <span className="tm-cc-pill tm-pe__count" data-testid="role-unsaved-count">
            {fill(
              t(
                changeCount === 1
                  ? 'PermissionEditor.unsavedOne'
                  : ('PermissionEditor.unsavedMany' as MessageKey),
              ),
              { count: changeCount },
            )}
          </span>
        ) : null}
      </div>

      {escalation ? (
        <InlineAlert tone="danger" title={t('PermissionEditor.escalationTitle')} live>
          {refused.length > 0
            ? fill(t('PermissionEditor.escalationNamed'), {
                capability: refused
                  .map((capability) => capabilityCellLabel(t, capability))
                  .join(', '),
              })
            : t('PermissionEditor.escalationBody')}
        </InlineAlert>
      ) : null}

      {compared && compareDiff ? (
        <div className="tm-cc-card tm-cc-card--quiet" data-testid="role-compare">
          <p className="tm-cc-card__title">
            {fill(t('PermissionEditor.compareTitle'), { role: roleLabel(t, compared.id) })}
          </p>
          <p className="tm-cc-card__body">
            {compareDiff.added.length === 0 && compareDiff.removed.length === 0
              ? t('PermissionEditor.compareSame')
              : null}
            {compareDiff.added.length > 0
              ? `${fill(t('PermissionEditor.compareOnlyBuiltIn'), { role: roleLabel(t, compared.id) })} ${compareDiff.added
                  .map((capability) => capabilityCellLabel(t, capability))
                  .join(', ')}. `
              : null}
            {compareDiff.removed.length > 0
              ? `${t('PermissionEditor.compareOnlyThis')} ${compareDiff.removed
                  .map((capability) => capabilityCellLabel(t, capability))
                  .join(', ')}.`
              : null}
          </p>
        </div>
      ) : null}

      <div className="tm-pe__layout">
        <PermissionMatrix
          mode={role.builtIn ? 'readonly' : 'edit'}
          value={value}
          initial={saved}
          ceiling={ceiling}
          rowAllToggles={!role.builtIn}
          columnAllToggles={!role.builtIn}
          label={fill(t('PermissionEditor.matrixLabel'), { role: role.name })}
          {...(role.builtIn ? {} : { onChange: (next: PermissionValue) => setValue(next) })}
        />

        <div className="tm-pe__aside">
          {role.builtIn ? (
            <section className="tm-cc-card">
              <h2 className="tm-cc-card__title">{t('PermissionEditor.builtInReadOnlyTitle')}</h2>
              <p className="tm-cc-card__body">{t('PermissionEditor.builtInReadOnlyBody')}</p>
            </section>
          ) : (
            <section className="tm-cc-card tm-stack" aria-labelledby="tm-pe-diff-title">
              <h2 id="tm-pe-diff-title" className="tm-cc-card__title">
                {changeCount === 1
                  ? t('PermissionEditor.diffTitleOne')
                  : t('PermissionEditor.diffTitle')}
              </h2>
              <p className="tm-cc-card__body">
                {escalation ? t('PermissionEditor.diffRefused') : t('PermissionEditor.diffSub')}
              </p>
              {changeCount === 0 ? (
                <p className="tm-cc-note">{t('PermissionEditor.diffNone')}</p>
              ) : (
                <ul className="tm-pe__diff" data-testid="role-diff">
                  {[
                    ...diff.added.map((c) => ['added', c] as const),
                    ...diff.removed.map((c) => ['removed', c] as const),
                  ].map(([kind, capability]) => (
                    <li key={capability} className="tm-pe__diff-item" data-change={kind}>
                      <span className={`tm-pe__dot tm-pe__dot--${kind}`} aria-hidden="true" />
                      <span className="tm-pe__sign" aria-hidden="true">
                        {kind === 'added' ? '+' : '−'}
                      </span>
                      <span>
                        {capabilityCellLabel(t, capability)}
                        <span className="tm-visually-hidden">
                          {' '}
                          {t(`PermissionMatrix.change.${kind}` as MessageKey)}
                        </span>
                        {showKeys ? (
                          <bdi dir="ltr" className="tm-pe__key">
                            {capability}
                          </bdi>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {withReason ? (
                <Field
                  label={t('PermissionEditor.reasonOptional')}
                  name="role-reason"
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.currentTarget.value)}
                />
              ) : null}
              {saveError && !escalation ? (
                <InlineAlert tone="danger" title={t('PermissionEditor.saveFailed')} live>
                  {describeError(saveError, t)}
                </InlineAlert>
              ) : null}
              <div className="tm-pe__actions">
                <Button
                  type="button"
                  tone="ink"
                  disabled={changeCount === 0 || (escalation !== null && refusedKey === valueKey)}
                  loading={saving}
                  loadingLabel={t('PermissionEditor.saving')}
                  onClick={() => void onSave(heldCapabilities(value), reason.trim())}
                >
                  {t('PermissionEditor.saveRole')}
                </Button>
                <Button
                  type="button"
                  tone="outline"
                  disabled={changeCount === 0 || saving}
                  onClick={() => {
                    setValue(saved);
                    setReason('');
                  }}
                >
                  {t('PermissionEditor.discard')}
                </Button>
              </div>
            </section>
          )}

          <section className="tm-cc-card tm-stack" aria-labelledby="tm-pe-builtin-title">
            <h2 id="tm-pe-builtin-title" className="tm-cc-card__title">
              {t('PermissionEditor.builtInTitle')}
            </h2>
            <p className="tm-cc-card__body">{t('PermissionEditor.builtInSub')}</p>
            <ul className="tm-pe__roles">
              {builtInRoles.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="tm-pe__role-row"
                    onClick={() => setViewing(entry)}
                  >
                    <span>{roleLabel(t, entry.id)}</span>
                    <span className="tm-pe__role-summary">
                      {t(`PermissionEditor.roleSummary.${entry.id}` as MessageKey)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>

      <UnsavedChangesGuard
        when={dirty}
        body={fill(t('PermissionEditor.guard.body'), {
          count: changeCount,
          role: role.name,
          holders: role.holders ?? 0,
        })}
        changes={diffLines(t, diff)}
      />

      {viewing ? (
        <PlatformDialog
          eyebrow={t('PermissionEditor.builtInEyebrow')}
          title={roleLabel(t, viewing.id)}
          width={880}
          onClose={() => setViewing(null)}
        >
          <PermissionMatrix
            mode="readonly"
            value={permissionValueOf(viewing.capabilities)}
            rowAllToggles={false}
            columnAllToggles={false}
            label={fill(t('PermissionEditor.matrixLabel'), { role: roleLabel(t, viewing.id) })}
          />
          <PlatformDialogActions>
            <Button type="button" tone="outline" onClick={() => setViewing(null)}>
              {t('PermissionEditor.close')}
            </Button>
          </PlatformDialogActions>
        </PlatformDialog>
      ) : null}

      {dialog === 'clone' && onClone ? (
        <CloneRoleDialog role={role} onClose={onDialogClose} onClone={onClone} />
      ) : null}
      {dialog === 'delete' && onDelete ? (
        <DeleteRoleDialog
          role={role}
          options={reassignOptions}
          onClose={onDialogClose}
          onDelete={onDelete}
        />
      ) : null}
    </div>
  );
}

function CloneRoleDialog({
  role,
  onClose,
  onClone,
}: {
  role: EditorRole;
  onClose: () => void;
  onClone: (name: string) => Promise<unknown>;
}) {
  const t = useT();
  const [name, setName] = useState(
    fill(t('PermissionEditor.cloneDefaultName'), { role: role.name }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <PlatformDialog title={t('PermissionEditor.cloneTitle')} onClose={onClose}>
      <p className="tm-cc-card__body">
        {fill(t('PermissionEditor.cloneBody'), { role: role.name })}
      </p>
      <Field
        label={t('PermissionEditor.newRoleName')}
        name="clone-name"
        value={name}
        maxLength={128}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      {error ? (
        <InlineAlert tone="danger" title={t('PermissionEditor.cloneFailed')} live>
          {describeError(error, t)}
        </InlineAlert>
      ) : null}
      <PlatformDialogActions>
        <Button type="button" tone="outline" onClick={onClose}>
          {t('PermissionEditor.cancel')}
        </Button>
        <Button
          type="button"
          tone="ink"
          loading={pending}
          loadingLabel={t('PermissionEditor.saving')}
          disabled={name.trim() === ''}
          onClick={() => {
            setPending(true);
            setError(null);
            onClone(name.trim())
              .then(onClose)
              .catch((caught: unknown) => setError(caught))
              .finally(() => setPending(false));
          }}
        >
          {t('PermissionEditor.cloneRole')}
        </Button>
      </PlatformDialogActions>
    </PlatformDialog>
  );
}

function DeleteRoleDialog({
  role,
  options,
  onClose,
  onDelete,
}: {
  role: EditorRole;
  options: readonly { readonly id: string; readonly label: string }[];
  onClose: () => void;
  onDelete: (reassignTo: string) => Promise<unknown>;
}) {
  const t = useT();
  const [target, setTarget] = useState(options[0]?.id ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <PlatformDialog
      title={fill(t('PermissionEditor.deleteTitle'), { role: role.name })}
      onClose={onClose}
    >
      <p className="tm-cc-card__body">
        {fill(t('PermissionEditor.deleteBody'), { holders: role.holders ?? 0 })}
      </p>
      <Select
        label={t('PermissionEditor.reassignLabel')}
        value={target}
        onChange={(event) => setTarget(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Select>
      {error ? (
        <InlineAlert tone="danger" title={t('PermissionEditor.deleteFailed')} live>
          {describeError(error, t)}
        </InlineAlert>
      ) : null}
      <PlatformDialogActions>
        <Button type="button" tone="outline" onClick={onClose}>
          {t('PermissionEditor.cancel')}
        </Button>
        <Button
          type="button"
          tone="destructive"
          loading={pending}
          loadingLabel={t('PermissionEditor.deleting')}
          disabled={target === ''}
          onClick={() => {
            setPending(true);
            setError(null);
            onDelete(target)
              .then(onClose)
              .catch((caught: unknown) => setError(caught))
              .finally(() => setPending(false));
          }}
        >
          {t('PermissionEditor.deleteConfirm')}
        </Button>
      </PlatformDialogActions>
    </PlatformDialog>
  );
}
