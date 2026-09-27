'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { fetchRequestTriage, putRequestTriage } from '../../lib/api/request-triage';
import type { RequestTriageView } from '../../lib/api/request-triage';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface RequestTriagePanelScreenProps {
  organizationSlug: string;
  organizationName: string;
  clientRequestId: string;
  /** Injected in tests. Defaults to the browser client. */
  client?: ApiClient;
}

/**
 * **Request triage** — module 11 (x265). The studio's internal triage of an incoming client request:
 * a category dropdown and an assignee, filed before commitment. It reads
 * `GET /v1/organizations/:orgSlug/client-requests/:id/triage` and writes it with the paired `PUT`,
 * both gated on the server by `client_request.triage`.
 *
 * The decisions are the sibling internal screens':
 * 1. **Authorization is the API's.** A caller without `client_request.triage` gets the ordinary 403,
 *    which `describe()` turns into a sentence in the panel's own alert; the screen never guesses a
 *    capability of its own and never renders blank on a refusal.
 * 2. **The category vocabulary is the fixed allowlist the API validates against.** An off-allowlist
 *    value cannot be chosen here, and if one were sent the API's 400 surfaces as an inline error.
 * 3. **The assignee is a membership id in this studio.** The API confirms it is an active member and
 *    returns a 404 otherwise; a blank assignee clears it.
 */

/** The category vocabulary, mirroring REQUEST_TRIAGE_CATEGORIES on the API with human labels. */
const CATEGORY_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'bug', label: 'Bug' },
  { id: 'change_request', label: 'Change request' },
  { id: 'question', label: 'Question' },
  { id: 'billing', label: 'Billing' },
  { id: 'feedback', label: 'Feedback' },
];

export function RequestTriagePanelScreen({
  organizationSlug,
  organizationName,
  clientRequestId,
  client,
}: RequestTriagePanelScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

  const triage = useQuery({
    queryKey: ['request-triage', organizationSlug, clientRequestId],
    queryFn: () => fetchRequestTriage(api, organizationSlug, clientRequestId),
  });

  const [category, setCategory] = useState<string>('general');
  const [assignee, setAssignee] = useState<string>('');

  // Seed the form from the loaded triage once, without clobbering an in-progress edit.
  useEffect(() => {
    if (triage.isSuccess && triage.data.triaged) {
      setCategory(triage.data.category ?? 'general');
      setAssignee(triage.data.assigneeMembershipId ?? '');
    }
  }, [
    triage.isSuccess,
    triage.data?.triaged,
    triage.data?.category,
    triage.data?.assigneeMembershipId,
  ]);

  const save = useMutation({
    mutationFn: () =>
      putRequestTriage(api, organizationSlug, clientRequestId, {
        category,
        assigneeMembershipId: assignee.trim() === '' ? null : assignee.trim(),
      }),
    onSuccess: (view: RequestTriageView) => {
      queryClient.setQueryData(['request-triage', organizationSlug, clientRequestId], view);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="work"
      title="Request triage"
      description="File an incoming client request under a category and assign it, before commitment."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-request-triage-heading">
        <h2 id="tm-request-triage-heading" className="tm-eyebrow">
          Triage
        </h2>

        <p className="tm-prose">
          <Link
            href={`/${encodeURIComponent(organizationSlug)}/work/requests/${encodeURIComponent(
              clientRequestId,
            )}`}
          >
            Back to the request
          </Link>
        </p>

        {triage.isPending ? (
          <LoadingRegion label="Loading triage." className="tm-stack tm-stack--tight">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}

        {triage.isError ? (
          <InlineAlert tone="danger" title="Could not load triage" live>
            {describe(triage.error)}
          </InlineAlert>
        ) : null}

        {triage.isSuccess ? (
          <form className="tm-stack tm-stack--loose" noValidate onSubmit={submit}>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-triage-category">
                Category
              </label>
              <select
                id="tm-triage-category"
                className="tm-field__control"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                {CATEGORY_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <Field
              label="Assign to (membership id)"
              name="assigneeMembershipId"
              value={assignee}
              onChange={(event) => setAssignee(event.target.value)}
              hint="Optional. An active member of this studio. Leave blank to leave the request unassigned."
            />

            {save.isError ? (
              <InlineAlert tone="danger" title="Could not save triage" live>
                {describe(save.error)}
              </InlineAlert>
            ) : null}

            {save.isSuccess ? (
              <InlineAlert tone="success" title="Triage saved" live>
                The request has been triaged.
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
                Save triage
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </AppShell>
  );
}

/** Turn a thrown error into a sentence, the shape the sibling screens use. */
function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The network dropped before triage could be reached.';
  return 'Something went wrong loading triage.';
}
