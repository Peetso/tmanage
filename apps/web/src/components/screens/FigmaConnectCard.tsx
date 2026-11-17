'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, StateCapsule } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import {
  completeFigmaConnect,
  connectFigma,
  disconnectFigma,
  getFigmaConnection,
  readFigmaReturn,
  startFigmaConnect,
  type FigmaConnection,
} from '../../lib/api/figma';
import { useT } from '../../lib/i18n/use-t';
import { useTOr } from '../../lib/i18n/use-t-or';
import '../viewer/figma-stage.css';
import { BrandLogo } from '../brand/BrandLogo';
import '../../styles/screens/connected-apps.css';
import { isServicePaused } from '../../lib/api/service-paused';
import { ServicePausedNotice } from './ServicePausedNotice';

/**
 * **V-52 — Connect Figma.** Each person connects their own Figma account with a personal access
 * token (read-only file access is enough), so the frames they attach can be shown as snapshots in
 * the viewer. Connected: their Figma handle, the token's last four characters and Disconnect. The
 * token itself is never shown again.
 */
export function FigmaConnectCard({
  api,
  organizationSlug,
  startOpen = false,
  returnTo,
}: {
  readonly api: ApiClient;
  readonly organizationSlug: string;
  /** FIX4 item 6: Integrations' Figma card opens the key form at once. */
  readonly startOpen?: boolean;
  /**
   * FIX4 item 6: where one-click Connect comes back to. Connected apps (members) handles the
   * return here; Integrations handles it on its own screen.
   */
  readonly returnTo?: 'integrations' | 'connected-apps';
}) {
  const t = useT();
  const tOr = useTOr();
  const id = useId();
  // FIX3 item 9 (live I2): the token is an advanced path, closed until Connect opens it.
  const [advancedOpen, setAdvancedOpen] = useState(startOpen);
  const tokenRef = useRef<HTMLDivElement | null>(null);
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
  // FIX4 item 6: one click — Figma's own sign-in when the server has it.
  const oneClick = useMutation({
    mutationFn: () => startFigmaConnect(api, organizationSlug, returnTo ?? 'connected-apps'),
    onSuccess: ({ url }) => globalThis.location.assign(url),
  });
  const complete = useMutation({
    mutationFn: (body: { readonly code: string; readonly state: string }) =>
      completeFigmaConnect(api, organizationSlug, body),
    onSuccess: save,
  });
  const [returnFailed, setReturnFailed] = useState(false);
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || returnTo === 'integrations') return;
    const back = readFigmaReturn(globalThis.location?.hash ?? '');
    if (!back) return;
    handled.current = true;
    globalThis.history?.replaceState(null, '', globalThis.location.pathname);
    if (back.kind === 'complete') complete.mutate({ code: back.code, state: back.state });
    else setReturnFailed(true);
  }, [complete, returnTo]);
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
            <p className={connected ? 'tm-connected__meta' : 'tm-connected__desc'}>
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
        ) : view?.oneClick ? (
          <Button
            tone="lime"
            loading={oneClick.isPending || complete.isPending}
            loadingLabel={t('Figma.connect.connecting')}
            onClick={() => oneClick.mutate()}
          >
            {tOr('Figma.connect.connectButton', 'Connect')}
          </Button>
        ) : view ? (
          <Button
            tone="ink"
            aria-expanded={advancedOpen}
            aria-controls={`${id}-advanced`}
            onClick={() => {
              setAdvancedOpen(true);
              requestAnimationFrame(() =>
                tokenRef.current?.querySelector<HTMLInputElement>('input')?.focus(),
              );
            }}
          >
            {tOr('Figma.connect.connectButton', 'Connect')}
          </Button>
        ) : null}
      </div>

      {connection.isError ? (
        <InlineAlert tone="danger">{t('Figma.connect.loadError')}</InlineAlert>
      ) : null}
      {view?.status === 'error' ? (
        <InlineAlert tone="warning">{t('Figma.connect.errorBody')}</InlineAlert>
      ) : null}
      {[connect, oneClick, complete].some((mutation) => isServicePaused(mutation.error)) ? (
        <ServicePausedNotice />
      ) : returnFailed || complete.isError || oneClick.isError ? (
        <InlineAlert tone="danger" live>
          {tOr(
            'IntegrationDirectoryScreen.figmaFailed',
            'Figma did not finish the sign-in, so nothing was changed. Press Connect to try again.',
          )}
        </InlineAlert>
      ) : null}
      {disconnect.isError ? (
        <InlineAlert tone="danger" live>
          {t('Figma.connect.saveError')}
        </InlineAlert>
      ) : null}

      {view && !connected && !view.oneClick ? (
        <details
          id={`${id}-advanced`}
          className="tm-figma-connect__advanced"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary>{tOr('Figma.connect.advanced', 'Advanced')}</summary>
          <p className="tm-connected__meta">
            {tOr(
              'Figma.connect.advancedWhy',
              'Figma sign-in is not switched on for this workspace yet, so Figma connects with a key you copy from your Figma settings. It takes a minute.',
            )}
          </p>
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
            <div ref={tokenRef}>
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
            </div>
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
        </details>
      ) : null}
    </section>
  );
}
