'use client';

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { readOrganizationMe } from '../../lib/api/permission-matrix';
import type { ApiClient } from '../../lib/api/client';
import {
  browserDisclosureStorage,
  readDisclosure,
  writeDisclosure,
  type DisclosureForm,
  type DisclosureStorage,
} from '../../lib/forms/disclosure-memory';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../../styles/screens/undo-and-access.css';

/**
 * The caller's user id in this organization, for keying per-person display memory. Shares the
 * `organization-me` cache with the other screens that ask; `undefined` until it answers (or if
 * it cannot), which the disclosure memory treats as "nobody in particular".
 */
export function useMyUserId(
  api: ApiClient,
  organizationSlug: string,
  enabled = true,
): string | undefined {
  const me = useQuery({
    queryKey: ['organization-me', organizationSlug],
    queryFn: () => readOrganizationMe(api, organizationSlug),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });
  return typeof me.data?.userId === 'string' ? me.data.userId : undefined;
}

/** Open/closed, remembered per person and form. Read after mount so SSR and hydration agree. */
export function useRememberedDisclosure(
  form: DisclosureForm,
  userId: string | undefined,
  storage: DisclosureStorage | null = browserDisclosureStorage(),
): readonly [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(false);
  useEffect(() => {
    setOpenState(readDisclosure(storage, userId, form));
    // `storage` is the browser's own object; only who and which form change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form, userId]);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      writeDisclosure(storage, userId, form, next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, userId],
  );
  return [open, setOpen] as const;
}

export interface MoreOptionsProps {
  readonly form: DisclosureForm;
  readonly userId: string | undefined;
  /** What is inside, in a few words ("Owner, labels, estimate"). */
  readonly hint?: string;
  /** Open regardless of memory — a hidden field has an error the person must see. */
  readonly forceOpen?: boolean;
  readonly children: ReactNode;
}

/**
 * 55-08 — a create form's secondary fields behind "More options" (Figma R50 L3, Product page
 * `594:34380`). Essentials stay above; the rest sits in a disclosure whose open state is
 * remembered for the person. The fields stay mounted while closed, so what was typed survives
 * closing it and is still submitted.
 */
export function MoreOptions({ form, userId, hint, forceOpen = false, children }: MoreOptionsProps) {
  const tOr = useTOr();
  const bodyId = useId();
  const [remembered, setOpen] = useRememberedDisclosure(form, userId);
  const open = remembered || forceOpen;

  return (
    <div className="tm-more-options" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="tm-more-options__toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen(!open)}
      >
        <span className="tm-more-options__chevron" aria-hidden="true">
          ›
        </span>
        {open ? tOr('MoreOptions.fewer', 'Fewer options') : tOr('MoreOptions.more', 'More options')}
        {!open && hint ? <span className="tm-more-options__hint">{hint}</span> : null}
      </button>
      <div id={bodyId} className="tm-more-options__body" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
