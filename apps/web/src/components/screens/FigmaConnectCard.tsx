'use client';

import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  connectFigma,
  disconnectFigma,
  getFigmaConnection,
  type FigmaConnection,
} from '../../lib/api/figma';
import { useT } from '../../lib/i18n/use-t';
import '../viewer/figma-stage.css';
import { BrandLogo } from '../brand/BrandLogo';

/**
 * **V-52 — Connect Figma.** Each person connects their own Figma account with a personal access
 * token (read-only file access is enough), so the frames they attach can be shown as snapshots in
 * the viewer. Connected: their Figma handle, the token's last four characters and Disconnect. The
 * token itself is never shown again.
 */
export function FigmaConnectCard({
  api,
  organizationSlug,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
}) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const queryKey = ['figma-connection', organizationSlug];
  const [token, setToken] = useState('');
  const connection = useQuery({
    queryKey,
    queryFn: () => getFigmaConnection(api, organizationSlug),
    retry: false,
  });
  const save = (view: FigmaConnection) => queryClient.setQueryData(queryKey, view);
  const connect = useMutation({
    mutationFn: () => connectFigma(api, organizationSlug, token.trim()),
    onSuccess: (view) => {
      setToken('');
      save(view);
    },
  });
  const disconnect = useMutation({
    mutationFn: () => disconnectFigma(api, organizationSlug),
    onSuccess: save,
  });

  const view = connection.data;
  const connected = view?.status === 'connected';
  const refused = connect.error instanceof ApiRequestError && connect.error.status === 422;

  return (
    <section className="tm-connected__app" aria-labelledby={`${id}-title`}>
      <div className="tm-connected__app-row">
        <div className="tm-connected__app-identity">
          <BrandLogo brand="figma" size={46} />
          <div className="tm-connected__app-text">
            <div className="tm-connected__app-name-row">
              <h2 id={`${id}-title`} className="tm-connected__app-name" dir="ltr">
                {t('Figma.connect.name')}
              </h2>
              {connected ? (
                <StateCapsule state="done">{t('Figma.connect.connected')}</StateCapsule>
              ) : view?.status === 'error' ? (
                <StateCapsule state="blocked">{t('Figma.connect.needsAttention')}</StateCapsule>
              ) : null}
            </div>
            <p className="tm-connected__meta">
              {connected
                ? t('Figma.connect.connectedAs')
                    .replace('{handle}', view.handle ?? '')
                    .replace('{hint}', view.tokenHint ?? '')
                : t('Figma.connect.description')}
            </p>
          </div>
        </div>
        {connected ? (
          <Button
            tone="outline"
            className="tm-connected__revoke"
            loading={disconnect.isPending}
            loadingLabel={t('Figma.connect.disconnecting')}
            onClick={() => disconnect.mutate()}
          >
            {t('Figma.connect.disconnect')}
          </Button>
        ) : null}
      </div>

      {connection.isError ? (
        <InlineAlert tone="danger">{t('Figma.connect.loadError')}</InlineAlert>
      ) : null}
      {view?.status === 'error' ? (
        <InlineAlert tone="warning">{t('Figma.connect.errorBody')}</InlineAlert>
      ) : null}
      {disconnect.isError ? (
        <InlineAlert tone="danger" live>
          {t('Figma.connect.saveError')}
        </InlineAlert>
      ) : null}

      {view && !connected ? (
        <form
          className="tm-figma-connect__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (token.trim() !== '') connect.mutate();
          }}
        >
          <ol className="tm-figma-connect__steps">
            <li>{t('Figma.connect.step1')}</li>
            <li>{t('Figma.connect.step2')}</li>
            <li>{t('Figma.connect.step3')}</li>
          </ol>
          <Field
            label={t('Figma.connect.tokenLabel')}
            hint={t('Figma.connect.tokenHint')}
            type="password"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            value={token}
            {...(refused ? { error: t('Figma.connect.refused') } : {})}
            onChange={(event) => {
              setToken(event.target.value);
              connect.reset();
            }}
          />
          {connect.isError && !refused ? (
            <InlineAlert tone="danger" live>
              {t('Figma.connect.saveError')}
            </InlineAlert>
          ) : null}
          <div>
            <Button
              type="submit"
              tone="ink"
              disabled={token.trim() === ''}
              loading={connect.isPending}
              loadingLabel={t('Figma.connect.connecting')}
            >
              {t('Figma.connect.submit')}
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}
