'use client';

import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchMemberProfile, saveMemberProfile } from '../../lib/api/member-profile';
import type { MemberProfileView } from '../../lib/api/member-profile';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import type { MessageKey } from '../../lib/i18n/t';
import { useT } from '../../lib/i18n/use-t';

export interface MemberProfileEditScreenProps {
  organizationSlug: string;
  organizationName: string;
  membershipId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/** The edit form's fields, kept as strings; an empty string is sent as `null` (cleared). */
interface FormState {
  department: string;
  bio: string;
  contactEmail: string;
  contactPhone: string;
}

function toForm(profile: MemberProfileView): FormState {
  return {
    department: profile.department ?? '',
    bio: profile.bio ?? '',
    contactEmail: profile.contactEmail ?? '',
    contactPhone: profile.contactPhone ?? '',
  };
}

/** An empty field is a cleared field: the API stores `null`, not an empty string. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * **Member profile edit** — x216, the writable counterpart to x169's read-only profile (module 14
 * People & capacity; re-scope of BLOCKED x192). It reads and saves `…/people/:membershipId/profile`
 * (gated on the server by `org.manage`) — the tenant-local `department`, `bio`, `contactEmail` and
 * `contactPhone`.
 *
 * The decisions are the sibling internal edit screens':
 * 1. **Authorization is the API's.** A caller without `org.manage`, or a cross-tenant/unknown id,
 *    gets the API's 403/404, which `describe()` turns into a sentence in the panel's alert; the
 *    screen never guesses a capability of its own.
 * 2. **It never edits `display_name`.** That field is GLOBAL on the users table and is the reason
 *    x192 was blocked — this screen has no control for it and the API route cannot write it.
 * 3. **An empty field clears the value.** PUT is a full replacement; a blank input is sent as `null`.
 */
export function MemberProfileEditScreen({
  organizationSlug,
  organizationName,
  membershipId,
  client,
}: MemberProfileEditScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const queryKey = ['member-profile', organizationSlug, membershipId];

  const profile = useQuery({
    queryKey,
    queryFn: () => fetchMemberProfile(api, organizationSlug, membershipId),
  });

  const [form, setForm] = useState<FormState>({
    department: '',
    bio: '',
    contactEmail: '',
    contactPhone: '',
  });

  // Seed the form once the current profile loads, so the fields show what is stored.
  useEffect(() => {
    if (profile.data) setForm(toForm(profile.data));
  }, [profile.data]);

  const save = useMutation({
    mutationFn: () =>
      saveMemberProfile(api, organizationSlug, membershipId, {
        department: orNull(form.department),
        bio: orNull(form.bio),
        contactEmail: orNull(form.contactEmail),
        contactPhone: orNull(form.contactPhone),
      }),
    onSuccess: async (saved) => {
      setForm(toForm(saved));
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const field =
    (key: keyof FormState) =>
    (event: ChangeEvent<HTMLInputElement>): void => {
      setForm((current) => ({ ...current, [key]: event.target.value }));
    };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title={t('MemberProfileEditScreen.title')}
      description={t('MemberProfileEditScreen.description')}
    >
      <p className="tm-prose">
        <Link href={`/${organizationSlug}/people`}>{t('MemberProfileEditScreen.backLink')}</Link>
      </p>

      <section className="tm-panel tm-stack" aria-labelledby="tm-member-profile-heading">
        <h2 id="tm-member-profile-heading" className="tm-eyebrow">
          {t('MemberProfileEditScreen.heading')}
        </h2>

        {profile.isPending ? (
          <LoadingRegion
            label={t('MemberProfileEditScreen.loadingLabel')}
            className="tm-stack tm-stack--tight"
          >
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {profile.isError ? (
          <InlineAlert tone="danger" title={t('MemberProfileEditScreen.loadErrorTitle')} live>
            {describe(t, profile.error)}
          </InlineAlert>
        ) : null}

        {profile.isSuccess ? (
          <form
            className="tm-stack"
            noValidate
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <Field
              label={t('MemberProfileEditScreen.departmentLabel')}
              name="department"
              value={form.department}
              onChange={field('department')}
              maxLength={120}
              hint={t('MemberProfileEditScreen.departmentHint')}
            />
            <Field
              label={t('MemberProfileEditScreen.bioLabel')}
              name="bio"
              value={form.bio}
              onChange={field('bio')}
              maxLength={2000}
              hint={t('MemberProfileEditScreen.bioHint')}
            />
            <Field
              label={t('MemberProfileEditScreen.contactEmailLabel')}
              name="contactEmail"
              type="email"
              value={form.contactEmail}
              onChange={field('contactEmail')}
              maxLength={320}
              hint={t('MemberProfileEditScreen.contactEmailHint')}
            />
            <Field
              label={t('MemberProfileEditScreen.contactPhoneLabel')}
              name="contactPhone"
              value={form.contactPhone}
              onChange={field('contactPhone')}
              maxLength={40}
              hint={t('MemberProfileEditScreen.contactPhoneHint')}
            />

            {save.isError ? (
              <InlineAlert tone="danger" title={t('MemberProfileEditScreen.saveErrorTitle')} live>
                {describe(t, save.error)}
              </InlineAlert>
            ) : null}

            {save.isSuccess ? (
              <InlineAlert
                tone="success"
                title={t('MemberProfileEditScreen.saveSuccessTitle')}
                live
              >
                {t('MemberProfileEditScreen.saveSuccessBody')}
              </InlineAlert>
            ) : null}

            <div>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending
                  ? t('MemberProfileEditScreen.savingLabel')
                  : t('MemberProfileEditScreen.saveSubmit')}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(t: (key: MessageKey) => string, error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return t('MemberProfileEditScreen.errorNetwork');
  return t('MemberProfileEditScreen.errorGeneric');
}
