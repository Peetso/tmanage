'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, InlineAlert, LoadingRegion, Skeleton, StatusDot } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { MemberSelect } from '../MemberSelect';
import { browserApiClient } from '../../lib/api/browser-client';
import { useMembers, memberKeys } from '../../lib/use-members';
import { memberDisplayName } from '../../lib/members-presentation';
import { getOffboardingImpact, offboardMember } from '../../lib/api/offboarding';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface OffboardingScreenProps {
  organizationSlug: string;
  organizationName: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **ADM-12 / ADM-13 — member offboarding.**
 *
 * `41-WHOLE-APP-SCREEN-AND-STATE-MATRIX` §Administration: offboarding shows the access and work a
 * member holds *before* the revocation, then executes it. This screen is that — a member picker, the
 * access-impact preview for whoever is chosen, and a confirmed offboard behind an explicit
 * acknowledgement that it cannot be undone.
 *
 * ## Why the acknowledgement, and why the API still owns the refusals
 *
 * Offboarding never restores access (`OFFBOARDING_NEVER_AUTO_RESTORES_ACCESS`), so the destructive
 * button is inert until the person ticks that they understand — a client-side courtesy, not a
 * control. The controls live on the API: it refuses a caller offboarding themselves, offboarding the
 * last member who can still administer the organization, and re-offboarding someone already
 * terminal, each with no write. This screen renders those refusals rather than trying to reproduce
 * them, because the browser cannot know who the last administrator is and must not pretend to.
 *
 * The picker offers active members only — the directory the API returns is active-only — so a member
 * who has just been offboarded drops out of it once the list is refetched, which is the visible
 * confirmation that the revocation took.
 */
export function OffboardingScreen({
  organizationSlug,
  organizationName,
  client,
}: OffboardingScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const directory = useMembers(api, organizationSlug, search);

  const impact = useQuery({
    queryKey: ['offboarding-impact', organizationSlug, selectedUserId],
    queryFn: () => getOffboardingImpact(api, organizationSlug, selectedUserId),
    enabled: selectedUserId !== '',
  });

  const offboard = useMutation({
    mutationFn: () => offboardMember(api, organizationSlug, selectedUserId),
    onSuccess: () => {
      // The offboarded member leaves the active directory, and the impact preview is now stale.
      void queryClient.invalidateQueries({ queryKey: memberKeys.all(organizationSlug) });
      void queryClient.invalidateQueries({ queryKey: ['offboarding-impact', organizationSlug] });
      setSelectedUserId('');
      setAcknowledged(false);
    },
  });

  const chosenName =
    selectedUserId === ''
      ? ''
      : memberDisplayName(selectedUserId, directory.members, directory.isPending);

  const canOffboard =
    selectedUserId !== '' &&
    impact.isSuccess &&
    impact.data.offboardable &&
    acknowledged &&
    !offboard.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="people"
      title="Offboard a member"
      description="Review the access a member holds, then revoke it. Offboarding cannot be undone."
    >
      <div className="tm-stack">
        <MemberSelect
          label="Member to offboard"
          members={directory.members}
          value={selectedUserId}
          onChange={(userId) => {
            setSelectedUserId(userId);
            setAcknowledged(false);
          }}
          onSearchChange={setSearch}
          loading={directory.isPending}
          failed={directory.isError}
          hint="Only active members can be offboarded."
        />

        {offboard.isSuccess ? (
          <InlineAlert tone="success" title="Member offboarded" live>
            Their access has been revoked. They no longer appear in the member list.
          </InlineAlert>
        ) : null}

        {selectedUserId === '' ? null : (
          <section
            className="tm-panel tm-stack"
            aria-label={`Offboarding impact for ${chosenName || 'the selected member'}`}
          >
            <h2 className="tm-heading">What {chosenName || 'this member'} holds</h2>

            {impact.isPending ? (
              <LoadingRegion
                label="Loading the access this member holds."
                className="tm-stack tm-stack--tight"
              >
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {impact.isError ? (
              <InlineAlert tone="danger" title="Could not load the impact preview" live>
                {describe(impact.error)}
              </InlineAlert>
            ) : null}

            {impact.isSuccess ? (
              <>
                <dl className="tm-detail-list">
                  <div className="tm-detail-list__pair">
                    <dt>Projects</dt>
                    <dd>{impact.data.projectMembershipCount} project memberships</dd>
                  </div>
                  <div className="tm-detail-list__pair">
                    <dt>Owned work</dt>
                    <dd>{impact.data.ownedWorkItemCount} work items</dd>
                  </div>
                  <div className="tm-detail-list__pair">
                    <dt>Status</dt>
                    <dd>
                      <StatusDot tone={impact.data.offboardable ? 'neutral' : 'danger'}>
                        {impact.data.status}
                      </StatusDot>
                    </dd>
                  </div>
                </dl>

                {impact.data.offboardable ? (
                  <>
                    <Checkbox
                      label="I understand offboarding cannot be undone."
                      checked={acknowledged}
                      onChange={(event) => setAcknowledged(event.target.checked)}
                    />
                    <div className="tm-row">
                      <Button
                        tone="destructive"
                        size="accessible"
                        loading={offboard.isPending}
                        loadingLabel="Offboarding"
                        disabled={!canOffboard}
                        onClick={() => offboard.mutate()}
                      >
                        Offboard {chosenName || 'this member'}
                      </Button>
                    </div>
                  </>
                ) : (
                  <InlineAlert tone="neutral" title="Already offboarded">
                    This member has already been offboarded. Their access cannot be revoked again.
                  </InlineAlert>
                )}
              </>
            ) : null}
          </section>
        )}

        {offboard.isError ? (
          <InlineAlert tone="danger" title="Offboarding failed" live>
            {describe(offboard.error)}
          </InlineAlert>
        ) : null}
      </div>
    </AppShell>
  );
}

/** Turn a thrown value into a sentence a person can act on. Never leaks a stack or a cause. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Check that it is running.';
  return 'Something went wrong. Try again.';
}
