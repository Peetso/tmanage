'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import { listSearchPins, pinEntity, unpinEntity } from '../../lib/api/search-pins';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface SearchPinsViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/** The entity kinds a member may pin — mirrors the API's fixed indexed-entity allowlist. */
const PIN_OBJECT_TYPES = [
  { value: 'work_item', label: 'Work item' },
  { value: 'document', label: 'Document' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'project', label: 'Project' },
] as const;

/**
 * **SRCH quick-access pins (x290).**
 *
 * `22-SCREEN SR` / `38-MODULE-MAP` §Search quick access: on top of the SRCH-01 global search (x111),
 * its ranking (x148) and saved/recent (x214), a member pins results they reach for often. This
 * screen is that surface — a quick-access strip of the caller's pins with an unpin control per row,
 * and a small form to pin an entity by type, id and label.
 *
 * Everything here is the caller's own: the API scopes each read, the pin and the unpin by tenant and
 * membership, so the screen renders what it is given. A pin holds only a type + id reference and a
 * cached label; the entity is read from its own read side, so a pin to something the caller can no
 * longer read simply shows as unavailable.
 */
export function SearchPinsView({
  organizationSlug,
  organizationName,
  client,
}: SearchPinsViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const [objectType, setObjectType] = useState<string>(PIN_OBJECT_TYPES[0].value);
  const [objectId, setObjectId] = useState('');
  const [label, setLabel] = useState('');

  const pinsKey = ['search-pins', organizationSlug];

  const pins = useQuery({
    queryKey: pinsKey,
    queryFn: () => listSearchPins(api, organizationSlug),
  });

  const create = useMutation({
    mutationFn: () =>
      pinEntity(api, organizationSlug, {
        objectType,
        objectId: objectId.trim(),
        label: label.trim(),
      }),
    onSuccess: () => {
      setObjectId('');
      setLabel('');
      void queries.invalidateQueries({ queryKey: pinsKey });
    },
  });

  const remove = useMutation({
    mutationFn: (pinId: string) => unpinEntity(api, organizationSlug, pinId),
    onSuccess: () => {
      void queries.invalidateQueries({ queryKey: pinsKey });
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (objectId.trim() === '' || label.trim() === '') return;
    create.mutate();
  }

  const pinList = pins.data ?? [];

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Pinned results"
      description="Keep the work, documents, meetings and projects you reach for often close to hand."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-pins-list">
        <h2 id="tm-pins-list" className="tm-eyebrow">
          Your pins
        </h2>
        {pins.isError ? (
          <InlineAlert tone="danger" title="Could not load your pins" live>
            {describeError(pins.error)}
          </InlineAlert>
        ) : null}
        {pins.isPending ? (
          <LoadingRegion label="Loading your pins.">
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {!pins.isPending && !pins.isError && pinList.length === 0 ? (
          <InlineAlert tone="neutral" title="No pins yet">
            Pin an entity below to keep it here for quick access.
          </InlineAlert>
        ) : null}
        {pinList.length > 0 ? (
          <ul className="tm-stack tm-list" aria-label="Your pinned results, most recent first">
            {pinList.map((item) => (
              <li key={item.id} className="tm-row">
                <span>{item.label}</span> <span className="tm-muted">({item.objectType})</span>{' '}
                <Button
                  type="button"
                  tone="outline"
                  size="accessible"
                  onClick={() => remove.mutate(item.id)}
                  disabled={remove.isPending}
                >
                  Unpin
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {remove.isError ? (
          <InlineAlert tone="danger" title="Could not unpin" live>
            {describeError(remove.error)}
          </InlineAlert>
        ) : null}
      </section>

      <section className="tm-panel tm-panel--quiet tm-stack" aria-labelledby="tm-pin-form">
        <h2 id="tm-pin-form" className="tm-eyebrow">
          Pin an entity
        </h2>
        <form className="tm-stack" onSubmit={onSubmit}>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-pin-type">
              Type
            </label>
            <select
              id="tm-pin-type"
              className="tm-field__control"
              value={objectType}
              onChange={(event) => setObjectType(event.target.value)}
            >
              {PIN_OBJECT_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-pin-id">
              Entity id
            </label>
            <input
              id="tm-pin-id"
              className="tm-field__control"
              type="text"
              value={objectId}
              onChange={(event) => setObjectId(event.target.value)}
              placeholder="The id of the item, document, meeting or project"
            />
          </div>
          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-pin-label">
              Label
            </label>
            <input
              id="tm-pin-label"
              className="tm-field__control"
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="A short name to show in the strip"
            />
          </div>
          <div>
            <Button
              type="submit"
              disabled={objectId.trim() === '' || label.trim() === '' || create.isPending}
            >
              Pin
            </Button>
          </div>
          {create.isError ? (
            <InlineAlert tone="danger" title="Could not pin" live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}
        </form>
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
