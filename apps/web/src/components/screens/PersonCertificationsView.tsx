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
        Certifications
      </h2>

      {certifications.isPending ? (
        <LoadingRegion label="Loading this person’s certifications.">
          <Skeleton height="var(--row)" />
          <Skeleton height="var(--row)" />
        </LoadingRegion>
      ) : null}

      {certifications.isError ? (
        <InlineAlert tone="danger" title="Could not load the certifications" live>
          {describe(certifications.error)}
        </InlineAlert>
      ) : null}

      {failure ? (
        <InlineAlert tone="danger" title="That did not go through" live>
          {failure}
        </InlineAlert>
      ) : null}

      {certifications.data ? (
        items.length === 0 ? (
          <p className="tm-prose">No certifications yet. Add the first one below.</p>
        ) : (
          <ul className="tm-list" aria-label="Person certifications">
            {items.map((certification) => (
              <li key={certification.id} className="tm-row">
                <span>
                  {certification.name} · {certification.issuer} · issued {certification.issuedOn}
                  {certification.expiresOn ? ` · expires ${certification.expiresOn}` : ''}
                  {certification.expired ? (
                    <>
                      {' '}
                      <Badge>Expired</Badge>
                    </>
                  ) : null}
                </span>
                <Button
                  type="button"
                  tone="text"
                  size="accessible"
                  loading={remove.isPending && remove.variables?.id === certification.id}
                  loadingLabel="Removing"
                  onClick={() => remove.mutate(certification)}
                >
                  Remove{' '}
                  <span className="tm-visually-hidden">the {certification.name} certification</span>
                </Button>
              </li>
            ))}
          </ul>
        )
      ) : null}

      <form className="tm-stack" noValidate onSubmit={submit}>
        <Field
          label="Certification name"
          name="certificationName"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
          hint="The credential, e.g. AWS Solutions Architect."
        />
        <Field
          label="Issuer"
          name="certificationIssuer"
          value={issuer}
          maxLength={200}
          onChange={(event) => setIssuer(event.target.value)}
          hint="Who issued it, e.g. Amazon Web Services."
        />
        <DateField
          label="Issued on"
          name="certificationIssuedOn"
          value={issuedOn}
          onValueChange={setIssuedOn}
        />
        <DateField
          label="Expires on"
          name="certificationExpiresOn"
          value={expiresOn}
          onValueChange={setExpiresOn}
          hint="Leave blank if the credential does not expire."
        />
        <div className="tm-row">
          <Button
            type="submit"
            tone="ink"
            size="accessible"
            loading={add.isPending}
            loadingLabel="Adding"
            disabled={!canSubmit}
          >
            Add certification
          </Button>
        </div>
      </form>
    </section>
  );
}
