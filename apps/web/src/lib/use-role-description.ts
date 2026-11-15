'use client';

import { useCallback } from 'react';
import { CLIENT_ROLES, INTERNAL_ROLES } from '@tmanage/domain';
import { describeInternalRole, type RoleDescription } from './roles';
import { useTOr } from './i18n/use-t-or';

/**
 * UX test T-P1-5: {@link describeInternalRole} in the reader's language.
 *
 * `lib/roles` keeps the English source of truth (and its type check that every role is described);
 * this hook looks each line up under `Roles.<role>.label`, `Roles.<role>.grant<n>` and
 * `Roles.<role>.withholds`, and falls back to the English line when a catalog lacks it. A role this
 * app does not know keeps its raw name as the label, as `lib/roles` does.
 */
export function useRoleDescription(): (role: string) => RoleDescription {
  const tr = useTOr();
  return useCallback(
    (role: string) => {
      const english = describeInternalRole(role);
      const known =
        (INTERNAL_ROLES as readonly string[]).includes(role) ||
        (CLIENT_ROLES as readonly string[]).includes(role);
      const base = known ? `Roles.${role}` : 'Roles.unknown';
      return {
        label: known ? tr(`${base}.label`, english.label) : english.label,
        grants: english.grants.map((grant, index) => tr(`${base}.grant${index + 1}`, grant)),
        withholds: tr(`${base}.withholds`, english.withholds),
      };
    },
    [tr],
  );
}

/** A membership or project status in the reader's language; an unknown one stays as it is. */
export function useStatusLabel(): (status: string) => string {
  const tr = useTOr();
  return useCallback((status: string) => tr(`PersonProfileScreen.status.${status}`, status), [tr]);
}
