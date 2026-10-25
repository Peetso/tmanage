'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { readCustomRoles } from '../../lib/api/admin-roles';
import type { CustomRoleView } from '../../lib/api/admin-roles';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  changeMemberRole,
  isMemberRoleChoice,
  listBuiltInRoles,
  MEMBER_ROLE_CHOICES,
} from '../../lib/api/member-role';
import type { MemberRoleChange, MemberRoleChoice } from '../../lib/api/member-role';
import { capabilityLabel } from '../../lib/capability-labels';
import { useTOr } from '../../lib/i18n/use-t-or';

/** Replace each `{slot}` in a catalog string. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/gu, (whole, slot: string) => values[slot] ?? whole);
}

/** "Maya Hassan" → "MH". */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? name;
}

/** The r-change-role / r-invite card copy, English defaults beside each key. */
const OPTION: Record<MemberRoleChoice, string> = {
  owner: 'Owner',
  org_admin: 'Admin',
  manager: 'Manager',
  member: 'Member',
};
const DESCRIBE: Record<MemberRoleChoice, string> = {
  owner: 'Full control of {org}, including billing and other owners.',
  org_admin: 'Manages people, settings and connected apps.',
  manager: "Runs projects and teams. Can't change workspace settings.",
  member: 'Works on the projects they are added to.',
};
const HINT: Record<MemberRoleChoice, string> = {
  owner: '{first} will get a notice. Owners have full control, including billing.',
  org_admin: '{first} will get a notice. Admins can manage people and settings.',
  manager: '{first} will get a notice. Managers can run projects and teams.',
  member: '{first} will get a notice. Members work on the projects they are added to.',
};

/** The short role name the roster chip and the confirm button use ("Admin", "Member"). */
const CHIP: Record<string, string> = {
  owner: 'Owner',
  org_admin: 'Admin',
  workspace_admin: 'Workspace admin',
  manager: 'Manager',
  moderator: 'Moderator',
  member: 'Member',
  guest: 'Guest',
};

/** One custom role from Control > Roles, as the role cards and the chips read it. */
export type CustomRoleOption = CustomRoleView['roles'][number];

/**
 * F1 — the organization's custom roles (Control > Roles, `GET admin/roles`), for the role cards
 * and for naming a member whose stored role is a custom role id. Only an owner or admin reads it.
 */
export function useCustomRoles(api: ApiClient, organizationSlug: string, enabled = true) {
  return useQuery({
    queryKey: ['custom-roles', organizationSlug],
    queryFn: async (): Promise<readonly CustomRoleOption[]> => {
      const view = await readCustomRoles(api, organizationSlug);
      return Array.isArray(view?.roles) ? view.roles : [];
    },
    enabled,
    retry: false,
  });
}

/**
 * The roster chip / confirm label for a stored role: a built-in name, or — F1 — a custom role's own
 * name when the stored role is that role's id.
 */
export function useRoleChipLabel(
  customRoles?: readonly CustomRoleOption[] | undefined,
): (role: string) => string {
  const tr = useTOr();
  return (role: string) => {
    const custom = customRoles?.find((entry) => entry.id === role);
    if (custom) return custom.name;
    return tr(`PeopleDirectoryScreen.role.${role}`, CHIP[role] ?? role);
  };
}

/** A custom role card's second line: its first rights, as Control > Roles lists them. */
function useCustomRoleSummary(): (role: CustomRoleOption) => string {
  const tr = useTOr();
  return (role: CustomRoleOption) => {
    const named = role.capabilities
      .slice(0, 3)
      .map((capability) => tr(`ChangeRoleDialog.right.${capability}`, capabilityLabel(capability)));
    return `${named.join(' · ')}${role.capabilities.length > 3 ? ' …' : ''}`;
  };
}

/**
 * The radio cards both dialogs draw: the four built-in roles (Owner / Admin / Manager / Member) and,
 * F1 (Figma 389:4749), a "Custom roles" group with the organization's roles from Control > Roles —
 * or, when there are none, one card that links to Control > Roles to make one. A built-in role the
 * caller may not hand out is drawn disabled, never hidden, so the choice reads the same for everyone.
 * The value is a built-in role name or a custom role id; both groups share one radio name.
 */
export function RoleChoiceCards({
  name,
  legend,
  value,
  onChange,
  assignable,
  organizationName,
  builtInHeading,
  customRoles,
  createRoleHref,
}: {
  name: string;
  legend: string;
  value: string | null;
  onChange: (role: string) => void;
  assignable: (role: MemberRoleChoice) => boolean;
  organizationName: string;
  /** Change role draws "Built-in roles" over the four; Invite has its own "Role" label. */
  builtInHeading?: string;
  /** The custom roles; `undefined` while they load (the group is not drawn yet). */
  customRoles?: readonly CustomRoleOption[] | undefined;
  /** Control > Roles, where the empty state's "Create a custom role" goes. */
  createRoleHref?: string;
}) {
  const tr = useTOr();
  const summary = useCustomRoleSummary();
  const customHeading = tr('ChangeRoleDialog.customRoles', 'Custom roles');
  const builtIn = (
    <fieldset className="ppl-role-cards">
      <legend className="tm-visually-hidden">{builtInHeading ?? legend}</legend>
      {MEMBER_ROLE_CHOICES.map((role) => {
        const disabled = !assignable(role);
        const describedBy = `${name}-${role}-describe`;
        return (
          <label
            key={role}
            className="ppl-role-card"
            data-checked={value === role}
            data-disabled={disabled}
          >
            <input
              type="radio"
              className="ppl-role-card__input"
              name={name}
              value={role}
              checked={value === role}
              disabled={disabled}
              aria-describedby={describedBy}
              onChange={() => onChange(role)}
            />
            <span className="ppl-role-card__title">
              {tr(`ChangeRoleDialog.option.${role}`, OPTION[role])}
            </span>
            <span className="ppl-role-card__describe" id={describedBy}>
              {fill(tr(`ChangeRoleDialog.describe.${role}`, DESCRIBE[role]), {
                org: organizationName,
              })}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
  const custom =
    customRoles === undefined ? null : (
      <div className="ppl-role-group">
        <p className="ppl-dialog__label" aria-hidden="true">
          {customHeading}
        </p>
        {customRoles.length === 0 ? (
          <div className="ppl-role-empty">
            <p className="ppl-role-empty__title">
              {tr('ChangeRoleDialog.customEmptyTitle', 'No custom roles yet')}
            </p>
            <p className="ppl-role-empty__body">
              {tr(
                'ChangeRoleDialog.customEmptyBody',
                'Make a role with only the rights you need, then give it to people here.',
              )}
            </p>
            {createRoleHref ? (
              <Link
                href={createRoleHref}
                className="tm-button tm-button--text tm-button--default ppl-role-empty__action"
              >
                {tr('ChangeRoleDialog.customCreate', 'Create a custom role')}
              </Link>
            ) : null}
          </div>
        ) : (
          <fieldset className="ppl-role-cards">
            <legend className="tm-visually-hidden">{customHeading}</legend>
            {customRoles.map((role) => {
              const describedBy = `${name}-custom-${role.id}-describe`;
              return (
                <label key={role.id} className="ppl-role-card" data-checked={value === role.id}>
                  <input
                    type="radio"
                    className="ppl-role-card__input"
                    name={name}
                    value={role.id}
                    checked={value === role.id}
                    aria-describedby={describedBy}
                    onChange={() => onChange(role.id)}
                  />
                  <span className="ppl-role-card__title">{role.name}</span>
                  <span className="ppl-role-card__describe" id={describedBy}>
                    {summary(role)}
                  </span>
                </label>
              );
            })}
          </fieldset>
        )}
      </div>
    );
  return (
    <>
      {builtInHeading ? (
        <div className="ppl-role-group">
          <p className="ppl-dialog__label" aria-hidden="true">
            {builtInHeading}
          </p>
          {builtIn}
        </div>
      ) : (
        builtIn
      )}
      {custom}
    </>
  );
}

export interface ChangeRoleTarget {
  readonly userId: string;
  readonly displayName: string;
  readonly role: string;
  /** The membership's version, when the roster carries it; sent as the compare-and-swap token. */
  readonly version?: number;
}

/**
 * **r-change-role / r-last-owner** (Figma 374:1985) — change one member's built-in role.
 *
 * The current-role card, the four role cards (what `GET admin/roles/built-in` calls assignable for
 * this caller — only an owner may make someone an owner), a hint for the chosen role, and
 * "Change to <role>". When the person is the organization's only active owner, the red note shows
 * and the confirm stays disabled: the API's 409 is the backstop, not the first answer. A stale
 * version (409) reloads the roster and asks again.
 */
export function ChangeRoleDialog({
  api,
  organizationSlug,
  organizationName,
  target,
  isOnlyOwner,
  onClose,
  onStale,
}: {
  api: ApiClient;
  organizationSlug: string;
  organizationName: string;
  target: ChangeRoleTarget;
  /** The target is the organization's only active owner (r-last-owner). */
  isOnlyOwner: boolean;
  onClose: (changed: MemberRoleChange | null) => void;
  /** A 409: the roster is stale and should be read again. */
  onStale: () => void;
}) {
  const tr = useTOr();
  const customRoles = useCustomRoles(api, organizationSlug);
  const customList = customRoles.isSuccess
    ? customRoles.data
    : customRoles.isError
      ? []
      : undefined;
  const chip = useRoleChipLabel(customList);
  const titleId = useId();
  const groupName = useId();
  const panelRef = useRef<HTMLElement>(null);
  const isCustom = (role: string) => customList?.some((entry) => entry.id === role) ?? false;
  const current = isMemberRoleChoice(target.role) || isCustom(target.role) ? target.role : null;
  const [picked, setChoice] = useState<string | null>(null);
  // Until the person picks, the current role is the checked card (a custom one once the list loads).
  const choice = picked ?? current;
  const first = firstNameOf(target.displayName);

  const roles = useQuery({
    queryKey: ['built-in-roles', organizationSlug],
    queryFn: () => listBuiltInRoles(api, organizationSlug),
    staleTime: 60_000,
  });
  const assignable = (role: MemberRoleChoice) =>
    roles.data?.some((entry) => entry.role === role && entry.assignable) ?? false;

  const change = useMutation({
    mutationFn: (role: string) =>
      changeMemberRole(api, organizationSlug, target.userId, {
        ...(isMemberRoleChoice(role) ? { role } : { customRoleId: role }),
        ...(target.version === undefined ? {} : { version: target.version }),
      }),
    onSuccess: (result) => onClose(result),
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409) onStale();
    },
  });

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('input:not([disabled]), button')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blocked = isOnlyOwner && target.role === 'owner';
  const canConfirm =
    !blocked &&
    choice !== null &&
    choice !== target.role &&
    (isMemberRoleChoice(choice) ? assignable(choice) : isCustom(choice)) &&
    !change.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canConfirm && choice !== null) change.mutate(choice);
  }

  function errorText(error: unknown): string {
    if (error instanceof ApiRequestError) {
      if (error.status === 409) {
        return target.role === 'owner' && error.message !== ''
          ? error.message
          : tr(
              'ChangeRoleDialog.stale',
              'Someone changed this member while you were looking. The list is up to date now; pick again.',
            );
      }
      if (error.status === 403 || error.status === 404) {
        return tr('ChangeRoleDialog.notAllowed', "You can't make this change.");
      }
    }
    return tr('ChangeRoleDialog.genericError', 'The role was not changed. Try again.');
  }

  const confirmRole = choice ?? current ?? 'member';

  return (
    <div className="ppl-dialog-scrim">
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ppl-dialog"
      >
        <h2 id={titleId} className="ppl-dialog__title">
          {tr('ChangeRoleDialog.title', 'Change role')}
        </h2>
        <form className="ppl-dialog__form" onSubmit={submit} noValidate>
          <p className="ppl-dialog__lede">
            {fill(
              blocked
                ? tr('ChangeRoleDialog.ledeLastOwner', 'Pick a new role for {name}.')
                : tr(
                    'ChangeRoleDialog.lede',
                    'Pick a new role for {name}. The change applies right away.',
                  ),
              { name: target.displayName },
            )}
          </p>

          <div className="ppl-current">
            <span className="ppl-avatar ppl-avatar--40" aria-hidden="true">
              {initialsOf(target.displayName)}
            </span>
            <span>
              <span className="ppl-current__name">{target.displayName}</span>
              <span className="ppl-current__role">
                {fill(tr('ChangeRoleDialog.currentRole', 'Current role: {role}'), {
                  role: chip(target.role),
                })}
              </span>
            </span>
          </div>

          {roles.isPending ? (
            <LoadingRegion label={tr('ChangeRoleDialog.rolesLoading', 'Loading roles')}>
              <Skeleton height="64px" />
              <Skeleton height="64px" />
            </LoadingRegion>
          ) : (
            <RoleChoiceCards
              name={groupName}
              legend={tr('ChangeRoleDialog.rolesLabel', 'Role')}
              value={choice}
              onChange={setChoice}
              assignable={assignable}
              organizationName={organizationName}
              builtInHeading={tr('ChangeRoleDialog.builtInRoles', 'Built-in roles')}
              customRoles={customList}
              createRoleHref={`/${encodeURIComponent(organizationSlug)}/admin/roles`}
            />
          )}

          {blocked ? (
            <div className="ppl-last-owner" role="note">
              <p className="ppl-last-owner__title">
                {fill(tr('ChangeRoleDialog.lastOwnerTitle', '{first} is the only owner'), {
                  first,
                })}
              </p>
              <p className="ppl-last-owner__body">
                {fill(
                  tr(
                    'ChangeRoleDialog.lastOwnerBody',
                    "Make someone else an owner first, then change {first}'s role.",
                  ),
                  { first },
                )}
              </p>
            </div>
          ) : choice !== null && choice !== target.role ? (
            <p className="ppl-dialog__hint">
              {isMemberRoleChoice(choice)
                ? fill(tr(`ChangeRoleDialog.hint.${choice}`, HINT[choice]), { first })
                : fill(
                    tr(
                      'ChangeRoleDialog.hint.custom',
                      '{first} will get a notice. They get the rights set for {role}.',
                    ),
                    { first, role: chip(choice) },
                  )}
            </p>
          ) : null}

          {change.isError ? (
            <InlineAlert tone="danger" live>
              {errorText(change.error)}
            </InlineAlert>
          ) : null}

          <div className="ppl-dialog__actions">
            <Button type="button" tone="outline" onClick={() => onClose(null)}>
              {tr('ChangeRoleDialog.cancel', 'Cancel')}
            </Button>
            <Button
              type="submit"
              tone="ink"
              disabled={!canConfirm}
              loading={change.isPending}
              loadingLabel={tr('ChangeRoleDialog.saving', 'Changing role…')}
            >
              {fill(tr('ChangeRoleDialog.confirm', 'Change to {role}'), {
                role: chip(confirmRole),
              })}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
