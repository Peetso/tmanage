'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Access policies"
      description="Organization-wide access policy. Changes apply to everyone in this organization."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-org-policies-heading">
        <h2 id="tm-org-policies-heading" className="tm-eyebrow">
          Access policy
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
            <Field
              label="Invite domain allowlist"
              name="invite_domain_allowlist"
              value={domains}
              onChange={(event) => setDomains(event.target.value)}
              hint="Comma-separated email domains an invitation may be addressed to. Leave empty for no restriction."
            />
            <Checkbox
              label="Allow guest access"
              name="guest_access_enabled"
              checked={guestAccess}
              onChange={(event) => setGuestAccess(event.target.checked)}
              hint="Whether external guests may access shared surfaces at all."
            />

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
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
