'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { readOrgPolicy, updateOrgPolicy, type OrgPolicyUpdateInput } from '../../lib/api/policies';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface AdminPoliciesScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Organization access policies (Administration module 18, x174).**
 *
 * `22-SCREEN-BY-SCREEN` §Administration (access policies). This screen reads the organization's access
 * policy — session lifetime, the invite-domain allowlist, and whether guest access is enabled — and
 * updates it. It is a faithful reader of the API's fixed-key allowlist: the fields shown are exactly the
 * typed policies the API returns, and a save PUTs the document, which the API validates against its
 * allowlist and per-key validators (an out-of-range or bad value is refused, with no write).
 *
 * ## What it does, and what it cannot
 *
 * - **This is the access-policy surface, not general settings.** x153's org-settings screen holds the
 *   general preferences (timezone, re-auth window); this is session lifetime, invite domains and guest
 *   access.
 * - **The role / capability editor is not here.** ADM-03 is blocked pending the permission-matrix work;
 *   broader security-policy escalations are deferred (NEXT-SCOPES-13).
 */
export function AdminPoliciesScreen({
  organizationSlug,
  organizationName,
  client,
}: AdminPoliciesScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const policy = useQuery({
    queryKey: ['org-policies', organizationSlug],
    queryFn: () => readOrgPolicy(api, organizationSlug),
  });

  const [sessionHours, setSessionHours] = useState('');
  const [domains, setDomains] = useState('');
  const [guestAccess, setGuestAccess] = useState(false);
  const [saved, setSaved] = useState(false);

  // Seed the editable fields from the loaded document once it arrives.
  useEffect(() => {
    if (!policy.data) return;
    setSessionHours(String(policy.data.policy.session_max_hours));
    setDomains(policy.data.policy.invite_domain_allowlist.join(', '));
    setGuestAccess(policy.data.policy.guest_access_enabled);
  }, [policy.data]);

  const save = useMutation({
    mutationFn: () => {
      const input: OrgPolicyUpdateInput = {
        session_max_hours: Number(sessionHours),
        invite_domain_allowlist: domains
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
        guest_access_enabled: guestAccess,
      };
      return updateOrgPolicy(api, organizationSlug, input);
    },
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['org-policies', organizationSlug] });
    },
  });

  const current = policy.data?.policy;

  return (
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="policies"
      crumbs={['Access policy']}
      title="Who may let someone in"
      actions={
        <Link
          href={`/${organizationSlug}/policies/simulate`}
          className="tm-button tm-button--outline tm-button--compact"
        >
          Simulate access
        </Link>
      }
    >
      <div className="tm-cc-split tm-cc-split--even">
        <section className="tm-cc-card" aria-labelledby="tm-org-policies-heading">
          <h2 id="tm-org-policies-heading" className="tm-cc-eyebrow">
            Access policy · applies to everyone
          </h2>

          {policy.isError ? (
            <InlineAlert tone="danger" title="Could not load the access policy" live>
              {describeError(policy.error)}
            </InlineAlert>
          ) : null}

          {policy.isPending ? (
            <LoadingRegion label="Loading the access policy.">
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {!policy.isPending && !policy.isError ? (
            <form
              className="tm-stack"
              noValidate
              aria-label="Access policy"
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                setSaved(false);
                if (!save.isPending) save.mutate();
              }}
            >
              <ul className="tm-cc-rows">
                <li>
                  <div className="tm-cc-rows__grow">
                    <Field
                      label="Invite domain allowlist"
                      name="invite_domain_allowlist"
                      value={domains}
                      onChange={(event) => setDomains(event.target.value)}
                      hint="Comma-separated email domains an invitation may be addressed to. Leave empty for no restriction."
                    />
                  </div>
                </li>
                <li>
                  <div className="tm-cc-rows__grow">
                    <Field
                      label="Session lifetime (hours)"
                      name="session_max_hours"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={720}
                      value={sessionHours}
                      onChange={(event) => setSessionHours(event.target.value)}
                      hint="How long a session may live before re-authentication is required. Between 1 and 720 hours."
                    />
                  </div>
                </li>
                <li>
                  <Checkbox
                    label="Allow guest access"
                    name="guest_access_enabled"
                    checked={guestAccess}
                    onChange={(event) => setGuestAccess(event.target.checked)}
                    hint="Whether external guests may access shared surfaces at all."
                  />
                  <span className={guestAccess ? 'tm-cc-pill tm-cc-pill--on' : 'tm-cc-pill'}>
                    {guestAccess ? 'On' : 'Off'}
                  </span>
                </li>
              </ul>

              {save.isError ? (
                <InlineAlert tone="danger" title="Could not save the access policy" live>
                  {describeError(save.error)}
                </InlineAlert>
              ) : null}
              {saved && !save.isPending && !save.isError ? (
                <InlineAlert tone="success" title="Saved" live>
                  The access policy has been updated for the whole organization.
                </InlineAlert>
              ) : null}

              <div className="tm-row">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={save.isPending}
                  loadingLabel="Saving"
                >
                  Save
                </Button>
              </div>
            </form>
          ) : null}
        </section>

        <section
          className="tm-cc-card tm-cc-card--flush tm-cc-card--fill"
          aria-labelledby="tm-org-policies-now"
        >
          <table className="tm-table tm-cc-table" aria-labelledby="tm-org-policies-now">
            <caption id="tm-org-policies-now" className="tm-visually-hidden">
              The saved access policy
            </caption>
            <thead>
              <tr>
                <th scope="col">In force now</th>
                <th scope="col" className="tm-cc-end">
                  Value
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <span className="tm-cc-cell-title">Invitations</span>
                  <span className="tm-cc-cell-sub">domains an invitation may go to</span>
                </td>
                <td className="tm-cc-end">
                  <span className="tm-cc-cell-mono">
                    {current
                      ? current.invite_domain_allowlist.length > 0
                        ? current.invite_domain_allowlist.join(', ')
                        : 'Any domain'
                      : '—'}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="tm-cc-cell-title">Session length</span>
                  <span className="tm-cc-cell-sub">before signing in again</span>
                </td>
                <td className="tm-cc-end">
                  <span className="tm-cc-cell-mono">
                    {current ? `${current.session_max_hours}h` : '—'}
                  </span>
                </td>
              </tr>
              <tr>
                <td>
                  <span className="tm-cc-cell-title">Guests</span>
                  <span className="tm-cc-cell-sub">external people on shared surfaces</span>
                </td>
                <td className="tm-cc-end">
                  {current ? (
                    <span
                      className={
                        current.guest_access_enabled ? 'tm-cc-pill tm-cc-pill--on' : 'tm-cc-pill'
                      }
                    >
                      {current.guest_access_enabled ? 'Allowed' : 'Off'}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </ControlCenterShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
