'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { useT } from '../../lib/i18n/use-t';
import type { MessageKey } from '../../lib/i18n/t';
import { fetchRequestTriage, putRequestTriage } from '../../lib/api/request-triage';
import type { RequestTriageView } from '../../lib/api/request-triage';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import '../../styles/screens/work-planning.css';

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
const CATEGORY_IDS = [
  'general',
  'bug',
  'change_request',
  'question',
  'billing',
  'feedback',
] as const;

const CATEGORY_KEY: Record<(typeof CATEGORY_IDS)[number], MessageKey> = {
  general: 'RequestTriagePanelScreen.catGeneral',
  bug: 'RequestTriagePanelScreen.catBug',
  change_request: 'RequestTriagePanelScreen.catChangeRequest',
  question: 'RequestTriagePanelScreen.catQuestion',
  billing: 'RequestTriagePanelScreen.catBilling',
  feedback: 'RequestTriagePanelScreen.catFeedback',
};

export function RequestTriagePanelScreen({
  organizationSlug,
  organizationName,
  clientRequestId,
  client,
}: RequestTriagePanelScreenProps) {
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();

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
      title={t('RequestTriagePanelScreen.title')}
      eyebrow={t('RequestTriagePanelScreen.eyebrow')}
      actions={
        <Link
          className="wp-capsule"
          href={`/${encodeURIComponent(organizationSlug)}/work/requests/${encodeURIComponent(
            clientRequestId,
          )}`}
        >
          {t('RequestTriagePanelScreen.backToRequest')}
        </Link>
      }
    >
      <section className="wp-triage" aria-labelledby="tm-request-triage-heading">
        <div className="wp-triage__asked">
          <h2 id="tm-request-triage-heading" className="wp-mono-label">
            {t('RequestTriagePanelScreen.triage')}
          </h2>
          <p className="wp-triage__quote">{t('RequestTriagePanelScreen.intro')}</p>

          {triage.isPending ? (
            <LoadingRegion
              label={t('RequestTriagePanelScreen.loading')}
              className="tm-stack tm-stack--tight"
            >
              <Skeleton height="var(--row)" />
              <Skeleton height="var(--row)" />
            </LoadingRegion>
          ) : null}

          {triage.isError ? (
            <InlineAlert tone="danger" title={t('RequestTriagePanelScreen.loadFailed')} live>
              {describe(triage.error)}
            </InlineAlert>
          ) : null}

          {triage.isSuccess ? (
            <form id="tm-request-triage-form" className="wp-stack" noValidate onSubmit={submit}>
              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-triage-category">
                  {t('RequestTriagePanelScreen.category')}
                </label>
                <select
                  id="tm-triage-category"
                  className="tm-field__control"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  {CATEGORY_IDS.map((id) => (
                    <option key={id} value={id}>
                      {t(CATEGORY_KEY[id])}
                    </option>
                  ))}
                </select>
              </div>

              <Field
                label={t('RequestTriagePanelScreen.assignTo')}
                name="assigneeMembershipId"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                hint={t('RequestTriagePanelScreen.assignHint')}
              />

              {save.isError ? (
                <InlineAlert tone="danger" title={t('RequestTriagePanelScreen.saveFailed')} live>
                  {describe(save.error)}
                </InlineAlert>
              ) : null}

              {save.isSuccess ? (
                <InlineAlert tone="success" title={t('RequestTriagePanelScreen.savedTitle')} live>
                  {t('RequestTriagePanelScreen.savedBody')}
                </InlineAlert>
              ) : null}
            </form>
          ) : null}
        </div>

        <div className="wp-triage__actions">
          {triage.isSuccess ? (
            <Button
              type="submit"
              form="tm-request-triage-form"
              tone="ink"
              size="accessible"
              loading={save.isPending}
              loadingLabel={t('RequestTriagePanelScreen.saving')}
            >
              {t('RequestTriagePanelScreen.saveTriage')}
            </Button>
          ) : null}
          <p className="wp-caption">{t('RequestTriagePanelScreen.caption')}</p>
        </div>
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
