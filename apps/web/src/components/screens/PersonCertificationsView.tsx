'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, DateField, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import {
  addPersonCertification,
  listPersonCertifications,
  removePersonCertification,
  type PersonCertificationSummary,
} from '../../lib/api/people-certifications';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface PersonCertificationsViewProps {
  organizationSlug: string;
  userId: string;
  api: ApiClient;
}

function describe(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}

/**
 * **x326 — a person's dated credentials / qualifications.** (People module 14; 22-SCREEN §Person
 * detail; the module map's "qualifications".)
 *
 * Record a certification (a name, an issuer, an issued date and an optional expiry), see the person's
 * certifications newest-first with an **Expired** badge the API computes read-side, and remove one.
 * This is distinct from the skills panel (x172): a certification is a dated credential, not a
 * self-assessed skill level. The panel keeps its own query and invalidates it on every write, so the
 * list reflects the server rather than an optimistic guess.
 */
export function PersonCertificationsView({
  organizationSlug,
  userId,
  api,
}: PersonCertificationsViewProps) {
  const queries = useQueryClient();
  const t = useT();
  const queryKey = ['person-certifications', organizationSlug, userId] as const;
  const [name, setName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [issuedOn, setIssuedOn] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [failure, setFailure] = useState<string | undefined>(undefined);

  const certifications = useQuery({
    queryKey,
    queryFn: () => listPersonCertifications(api, organizationSlug, userId),
  });

  function refresh() {
    void queries.invalidateQueries({ queryKey });
  }

  const add = useMutation({
    mutationFn: (input: {
      name: string;
      issuer: string;
      issuedOn: string;
      expiresOn: string | null;
    }) => addPersonCertification(api, organizationSlug, userId, input),
    onSuccess: () => {
      setName('');
      setIssuer('');
      setIssuedOn('');
      setExpiresOn('');
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  const remove = useMutation({
    mutationFn: (certification: PersonCertificationSummary) =>
      removePersonCertification(api, organizationSlug, userId, certification.id),
    onSuccess: () => {
      setFailure(undefined);
      refresh();
    },
    onError: (error) => setFailure(describe(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedIssuer = issuer.trim();
    if (trimmedName === '' || trimmedIssuer === '' || issuedOn === '') return;
    add.mutate({
      name: trimmedName,
      issuer: trimmedIssuer,
      issuedOn,
      expiresOn: expiresOn === '' ? null : expiresOn,
    });
  }

  const items = certifications.data ?? [];
  const canSubmit = name.trim() !== '' && issuer.trim() !== '' && issuedOn !== '';

  return (
    <section className="tm-panel tm-stack" aria-labelledby="tm-person-certifications">
      <h2 id="tm-person-certifications" className="tm-eyebrow">
        {t('PersonCertificationsView.heading')}
      </h2>

      {certifications.isPending ? (
        <LoadingRegion label={t('PersonCertificationsView.loading')}>
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {certifications.isError ? (
        <InlineAlert tone="danger" title={t('PersonCertificationsView.loadError')} live>
          {describe(certifications.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title={t('PersonCertificationsView.failureTitle')} live>
          {failure}
        </InlineAlert>
      ) : null}

      {certifications.data ? (
        items.length === 0 ? (
          <p className="tm-prose">{t('PersonCertificationsView.empty')}</p>
        ) : (
          <ul className="tm-list" aria-label={t('PersonCertificationsView.listLabel')}>
            {items.map((certification) => (
              <li key={certification.id} className="tm-row">
                <span>
                  {certification.name} · {certification.issuer} ·{' '}
                  {t('PersonCertificationsView.issuedWord')} {certification.issuedOn}
                  {certification.expiresOn
                    ? ` · ${t('PersonCertificationsView.expiresWord')} ${certification.expiresOn}`
                    : ''}
                  {certification.expired ? (
                    <>
                      {' '}
                      <Badge>{t('PersonCertificationsView.expired')}</Badge>
                    </>
                  ) : null}
                </span>
                <Button
                  type="button"
                  tone="text"
                  size="accessible"
                  loading={remove.isPending && remove.variables?.id === certification.id}
                  loadingLabel={t('PersonCertificationsView.removing')}
                  onClick={() => remove.mutate(certification)}
                >
                  {t('PersonCertificationsView.remove')}{' '}
                  <span className="tm-visually-hidden">
                    {t('PersonCertificationsView.removeSrPrefix')} {certification.name}{' '}
                    {t('PersonCertificationsView.removeSrSuffix')}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label={t('PersonCertificationsView.certNameLabel')}
          name="certificationName"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          hint={t('PersonCertificationsView.certNameHint')}
        />
        <Field
          label={t('PersonCertificationsView.issuerLabel')}
          name="certificationIssuer"
          value={issuer}
          maxLength={200}
          onChange={(event) => setIssuer(event.target.value)}
          hint={t('PersonCertificationsView.issuerHint')}
        />
        <DateField
          label={t('PersonCertificationsView.issuedOnLabel')}
          name="certificationIssuedOn"
          value={issuedOn}
          onValueChange={setIssuedOn}
        />
        <DateField
          label={t('PersonCertificationsView.expiresOnLabel')}
          name="certificationExpiresOn"
          value={expiresOn}
          onValueChange={setExpiresOn}
          hint={t('PersonCertificationsView.expiresOnHint')}
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel={t('PersonCertificationsView.adding')}
            disabled={!canSubmit}
          >
            {t('PersonCertificationsView.addCertification')}
          </Button>
        </div>
      </form>
    </section>
  );
}
