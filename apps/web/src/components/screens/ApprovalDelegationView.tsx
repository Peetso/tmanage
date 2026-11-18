'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  createApprovalDelegation,
  listApprovalDelegations,
  revokeApprovalDelegation,
} from '../../lib/api/approval-delegations';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface ApprovalDelegationViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** A `datetime-local` value ("2026-10-01T09:00") to an ISO-8601 instant, or null if unset/invalid. */
function toInstant(local: string): string | null {
  if (local.trim() === '') return null;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * **x300 — approval delegation.** (Approvals module, APR screen.)
 *
 * "Delegate my approvals": an approver hands their approval authority to another member for a window,
 * sees their active delegations, and revokes one. Create and revoke are gated on the server by
 * `approval.decide` (the delegator delegates the authority they hold) and the list by `approval.read`,
 * so a member without the capability sees the API's refusal rather than a blank page. The delegator is
 * always the acting member — this screen never names one — and the delegate is resolved active and in
 * the same tenant by the API, which answers a cross-tenant delegate with a not-found.
 */
export function ApprovalDelegationView({
  organizationSlug,
  organizationName,
  client,
}: ApprovalDelegationViewProps) {
  const describe = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queries = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const queryKey = ['approval-delegations', organizationSlug] as const;

  const [delegateMembershipId, setDelegate] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const delegations = useQuery({
    queryKey,
    queryFn: () => listApprovalDelegations(api, organizationSlug),
  });

  const create = useMutation({
    mutationFn: () => {
      const starts = toInstant(startsAt);
      const ends = toInstant(endsAt);
      if (starts === null || ends === null) {
        throw new Error(t('ApprovalDelegationView.windowRequired'));
      }
      return createApprovalDelegation(api, organizationSlug, {
        delegateMembershipId: delegateMembershipId.trim(),
        startsAt: starts,
        endsAt: ends,
      });
    },
    onSuccess: async () => {
      setDelegate('');
      setStartsAt('');
      setEndsAt('');
      setFailure(undefined);
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApprovalDelegation(api, organizationSlug, id),
    onSuccess: async () => {
      await queries.invalidateQueries({ queryKey });
    },
    onError: (error) => setFailure(describe(error)),
  });

  const rows = delegations.data ?? [];
  const canCreate =
    delegateMembershipId.trim() !== '' && startsAt !== '' && endsAt !== '' && !create.isPending;

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('ApprovalDelegationView.title')}
      description={t('ApprovalDelegationView.description')}
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-delegation-new-heading">
        <h2 id="tm-delegation-new-heading" className="tm-eyebrow">
          {t('ApprovalDelegationView.newDelegationHeading')}
        </h2>
        <form
          ref={firstStep}
          className="tm-stack"
          noValidate
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            if (canCreate) create.mutate();
          }}
        >
          <Field
            label={t('ApprovalDelegationView.delegateLabel')}
            name="delegateMembershipId"
            value={delegateMembershipId}
            onChange={(event) => setDelegate(event.target.value)}
            hint={t('ApprovalDelegationView.delegateHint')}
            required
          />

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-delegation-starts">
              {t('ApprovalDelegationView.startsLabel')}
            </label>
            <input
              id="tm-delegation-starts"
              className="tm-field__control"
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-delegation-ends">
              {t('ApprovalDelegationView.endsLabel')}
            </label>
            <input
              id="tm-delegation-ends"
              className="tm-field__control"
              type="datetime-local"
              value={endsAt}
              onChange={(event) => setEndsAt(event.target.value)}
            />
          </div>

          {failure ? (
            <InlineAlert tone="danger" title={t('ApprovalDelegationView.delegateError')} live>
              {failure}
            </InlineAlert>
          ) : null}

          <div className="tm-row">
            <Button
              type="submit"
              tone="ink"
              size="accessible"
              loading={create.isPending}
              loadingLabel={t('ApprovalDelegationView.saving')}
              disabled={!canCreate}
            >
              {t('ApprovalDelegationView.delegate')}
            </Button>
          </div>
        </form>
      </section>

      <section className="tm-panel tm-stack" aria-labelledby="tm-delegation-list-heading">
        <h2 id="tm-delegation-list-heading" className="tm-eyebrow">
          {t('ApprovalDelegationView.activeDelegationsHeading')}
        </h2>
        {delegations.isPending ? (
          <LoadingRegion label={t('ApprovalDelegationView.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {delegations.isError ? (
          <InlineAlert tone="danger" title={t('ApprovalDelegationView.loadError')} live>
            {describe(delegations.error)}
          </InlineAlert>
        ) : null}

        {delegations.data ? (
          rows.length === 0 ? (
            <TeachingEmptyState
              title={t('teachEmpty.approvalDelegationTitle')}
              explanation={t('teachEmpty.approvalDelegationBody')}
              action={
                canUse('approval.decide') ? (
                  <Button
                    tone="lime"
                    size="accessible"
                    onClick={() => focusFirstField(firstStep.current)}
                  >
                    {t('teachEmpty.approvalDelegationAction')}
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ul className="tm-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {rows.map((delegation) => (
                <li key={delegation.id} className="tm-row tm-row--between">
                  <span className="tm-prose">
                    {delegation.delegateMembershipId} — {delegation.startsAt} to {delegation.endsAt}
                  </span>
                  <Button
                    type="button"
                    tone="text"
                    size="accessible"
                    loading={revoke.isPending}
                    loadingLabel={t('ApprovalDelegationView.revoking')}
                    onClick={() => revoke.mutate(delegation.id)}
                  >
                    {t('ApprovalDelegationView.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>
    </AppShell>
  );
}
