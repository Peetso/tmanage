'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { useT } from '../../lib/i18n/use-t';
import { shortRef } from './SearchScreen';
import '../../styles/screens/search-ai.css';
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
  const t = useT();
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
      title={t('SearchPinsView.title')}
      eyebrow={t('SearchPinsView.eyebrow')}
      {...(pinList.length > 0
        ? { titleMeta: `${pinList.length} ${t('SearchPinsView.pinned')}` }
        : {})}
      description={t('SearchPinsView.description')}
    >
      <section className="tm-stack" aria-labelledby="tm-pins-list">
        <h2 id="tm-pins-list" className="tm-sa-eyebrow">
          {t('SearchPinsView.yourPinsHeading')}
          {pinList.length > 0 ? ` · ${pinList.length}` : ''}
        </h2>
        {pins.isError ? (
          <InlineAlert tone="danger" title={t('SearchPinsView.loadError')} live>
            {describeError(pins.error)}
          </InlineAlert>
        ) : null}
        {pins.isPending ? (
          <LoadingRegion label={t('SearchPinsView.loading')}>
            <Skeleton height="var(--row)" />
            <Skeleton height="var(--row)" />
          </LoadingRegion>
        ) : null}
        {!pins.isPending && !pins.isError && pinList.length === 0 ? (
          <div className="tm-sa-empty">
            <p className="tm-sa-empty__title">{t('SearchPinsView.emptyTitle')}</p>
            <p className="tm-sa-empty__body">{t('SearchPinsView.emptyBody')}</p>
          </div>
        ) : null}
        {pinList.length > 0 ? (
          <ul className="tm-sa-pins" aria-label={t('SearchPinsView.listAria')}>
            {pinList.map((item) => (
              <li key={item.id} className="tm-sa-hit">
                <div className="tm-sa-hit__head">
                  <span className="tm-sa-badge">{typeLabel(item.objectType)}</span>
                  <span className="tm-sa-hit__ref" aria-hidden="true">
                    {shortRef(item.objectId)}
                  </span>
                </div>
                <span className="tm-sa-hit__title">{item.label}</span>
                <div className="tm-sa-hit__actions">
                  <button
                    type="button"
                    className="tm-sa-capsule"
                    onClick={() => remove.mutate(item.id)}
                    disabled={remove.isPending}
                    aria-label={`${t('SearchPinsView.unpin')} ${item.label}`}
                  >
                    {t('SearchPinsView.unpin')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {remove.isError ? (
          <InlineAlert tone="danger" title={t('SearchPinsView.unpinError')} live>
            {describeError(remove.error)}
          </InlineAlert>
        ) : null}
      </section>

      <section className="tm-sa-form" aria-labelledby="tm-pin-form">
        <h2 id="tm-pin-form" className="tm-sa-eyebrow">
          {t('SearchPinsView.pinFormHeading')}
        </h2>
        <form className="tm-stack" onSubmit={onSubmit}>
          <div className="tm-sa-form__fields">
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-pin-type">
                {t('SearchPinsView.typeLabel')}
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
                {t('SearchPinsView.entityIdLabel')}
              </label>
              <input
                id="tm-pin-id"
                className="tm-field__control"
                type="text"
                value={objectId}
                onChange={(event) => setObjectId(event.target.value)}
                placeholder={t('SearchPinsView.entityIdPlaceholder')}
              />
            </div>
            <div className="tm-field">
              <label className="tm-field__label" htmlFor="tm-pin-label">
                {t('SearchPinsView.labelLabel')}
              </label>
              <input
                id="tm-pin-label"
                className="tm-field__control"
                type="text"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('SearchPinsView.labelPlaceholder')}
              />
            </div>
          </div>
          <div className="tm-sa-form__actions">
            <Button
              type="submit"
              disabled={objectId.trim() === '' || label.trim() === '' || create.isPending}
            >
              {t('SearchPinsView.pin')}
            </Button>
          </div>
          {create.isError ? (
            <InlineAlert tone="danger" title={t('SearchPinsView.pinError')} live>
              {describeError(create.error)}
            </InlineAlert>
          ) : null}
        </form>
      </section>
    </AppShell>
  );
}

function typeLabel(objectType: string): string {
  return PIN_OBJECT_TYPES.find((option) => option.value === objectType)?.label ?? objectType;
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
