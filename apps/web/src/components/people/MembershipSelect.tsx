'use client';

import { useQuery } from '@tanstack/react-query';
import { Select } from '@tmanage/ui';
import type { ReactNode } from 'react';
import type { ApiClient } from '../../lib/api/client';
import { listPeople, type PersonSummary } from '../../lib/api/people';

/**
 * The organization's people, read once per organization under the directory's own key, so the
 * directory, the pickers below and every "who holds this" lookup share one request and one answer.
 */
export function usePeopleDirectory(api: ApiClient, organizationSlug: string) {
  return useQuery({
    queryKey: ['people-directory', organizationSlug, ''],
    queryFn: () => listPeople(api, organizationSlug, {}),
  });
}

export interface MembershipSelectProps {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  /** The empty first option, e.g. "Choose a member". */
  readonly placeholder: string;
  readonly people: readonly PersonSummary[];
  /** The chosen membership id, or `''` for none. */
  readonly value: string;
  readonly onChange: (membershipId: string) => void;
  readonly name: string;
  readonly required?: boolean;
  readonly disabled?: boolean;
}

/**
 * A member chosen by name, for the screens whose API takes a **membership** id (seats, the policy
 * simulator). The id stays what the API is sent; a person never types or reads it (D16). Work
 * fields that store a user id use `MemberSelect` instead.
 */
export function MembershipSelect({
  label,
  hint,
  placeholder,
  people,
  value,
  onChange,
  name,
  required = false,
  disabled = false,
}: MembershipSelectProps) {
  return (
    <Select
      label={label}
      name={name}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      {...(hint === undefined ? {} : { hint })}
      required={required}
      disabled={disabled}
    >
      <option value="">{placeholder}</option>
      {people.map((person) => (
        <option key={person.membershipId} value={person.membershipId}>
          {person.displayName}
        </option>
      ))}
    </Select>
  );
}
