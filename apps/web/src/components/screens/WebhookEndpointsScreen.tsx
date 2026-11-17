'use client';

import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterShell } from '../admin/ControlCenterShell';
import '../../styles/screens/automations.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listWebhookEndpoints,
  registerWebhookEndpoint,
  setWebhookEndpointEnabled,
  WEBHOOK_EVENT_KINDS,
  webhookEventLabel,
  webhookEventMessageKey,
  type WebhookEndpointSummary,
  type WebhookEventKind,
} from '../../lib/api/webhooks';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { TeachingEmptyState, focusFirstField } from '../help/TeachingEmptyState';
import { useShellCapability } from '../shell/use-shell-capability';
import { useTOr } from '../../lib/i18n/use-t-or';
import { useDescribeApiError } from '../../lib/api/describe-error';

export interface WebhookEndpointsScreenProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

/**
 * **Automations webhooks (module 17, x166).**
 *
 * `38-COMPLETE-PRODUCT-SCOPE-AND-MODULE-MAP` §Automations ("webhooks"); audit rank #2. Registers an
 * outbound webhook endpoint (an https target, an event kind, and a signing secret), lists the
 * organization's endpoints, and toggles one enabled/disabled. Gated on `org.manage` by the API, so a
 * caller without the capability sees the API's refusal rather than a blank page.
 *
 * The signing secret is write-only: it is sent on register and never returned, so the list never
 * shows it. This slice registers and validates endpoints; actual delivery to third parties is a later
 * slice (external egress + retry infra).
 */
export function WebhookEndpointsScreen({
  organizationSlug,
  organizationName,
  client,
}: WebhookEndpointsScreenProps) {
  const describeError = useDescribeApiError();
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();
  const t = useT();
  const canUse = useShellCapability(organizationSlug, client);
  const firstStep = useRef<HTMLFormElement>(null);
  const tOr = useTOr();
  const eventName = (kind: string) => tOr(webhookEventMessageKey(kind), webhookEventLabel(kind));

  const endpoints = useQuery({
    queryKey: ['webhook-endpoints', organizationSlug],
    queryFn: () => listWebhookEndpoints(api, organizationSlug),
  });

  const [url, setUrl] = useState('');
  const [eventKind, setEventKind] = useState<WebhookEventKind>(WEBHOOK_EVENT_KINDS[0]);
  const [secret, setSecret] = useState('');

  const register = useMutation({
    mutationFn: () =>
      registerWebhookEndpoint(api, organizationSlug, {
        url: url.trim(),
        eventKind,
        secret,
      }),
    onSuccess: async () => {
      setUrl('');
      setSecret('');
      setEventKind(WEBHOOK_EVENT_KINDS[0]);
      await queryClient.invalidateQueries({ queryKey: ['webhook-endpoints', organizationSlug] });
    },
  });

  const toggle = useMutation({
    mutationFn: (endpoint: WebhookEndpointSummary) =>
      setWebhookEndpointEnabled(api, organizationSlug, endpoint.id, !endpoint.enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['webhook-endpoints', organizationSlug] });
    },
  });

  const rows = endpoints.data ?? [];
  const canRegister = url.trim() !== '' && secret.length >= 16 && !register.isPending;
  const enabledCount = rows.filter((endpoint) => endpoint.enabled).length;

  return (
    // C19: the Control Center frame, like every other admin page. Inside the app shell the
    // Control Center menu sat beside the app's own side menu, so the page showed two.
    <ControlCenterShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      section="integrations"
      crumbs={[t('ControlCenterShell.integrations'), t('WebhookEndpointsScreen.title')]}
      {...(client ? { client } : {})}
      title={t('WebhookEndpointsScreen.title')}
      {...(rows.length > 0
        ? {
            titleMeta: `${rows.length} ${rows.length === 1 ? t('WebhookEndpointsScreen.endpointSingular') : t('WebhookEndpointsScreen.endpointPlural')} · ${enabledCount} ${t('WebhookEndpointsScreen.on')}`,
          }
        : {})}
      description={t('WebhookEndpointsScreen.description')}
      actions={
        <Link href={`/${organizationSlug}/automations/apps`} className="tm-aut-btn">
          {t('WebhookEndpointsScreen.allIntegrations')}
        </Link>
      }
    >
      <div className="tm-aut">
        <div className="tm-aut-split">
          <section className="tm-aut-card" aria-labelledby="tm-webhook-list-heading">
            <div className="tm-row tm-row--between">
              <h2
                id="tm-webhook-list-heading"
                className="tm-aut-card__title tm-aut-card__title--section"
              >
                {t('WebhookEndpointsScreen.endpoints')}
              </h2>
              {rows.length > 0 ? (
                <span className="tm-aut-mono">
                  {rows.length} {t('WebhookEndpointsScreen.registered')} · {enabledCount}{' '}
                  {t('WebhookEndpointsScreen.on')}
                </span>
              ) : null}
            </div>

            {toggle.isError ? (
              <InlineAlert tone="danger" title={t('WebhookEndpointsScreen.updateError')} live>
                {describeError(toggle.error)}
              </InlineAlert>
            ) : null}

            {endpoints.isError ? (
              <InlineAlert tone="danger" title={t('WebhookEndpointsScreen.loadError')} live>
                {describeError(endpoints.error)}
              </InlineAlert>
            ) : null}

            {endpoints.isPending ? (
              <LoadingRegion label={t('WebhookEndpointsScreen.loading')}>
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!endpoints.isPending && !endpoints.isError && rows.length === 0 ? (
              <TeachingEmptyState
                title={t('WebhookEndpointsScreen.emptyTitle')}
                explanation={t('teachEmpty.webhooksBody')}
                action={
                  canUse('org.manage') ? (
                    <Button
                      tone="lime"
                      size="accessible"
                      onClick={() => focusFirstField(firstStep.current)}
                    >
                      {t('teachEmpty.webhooksAction')}
                    </Button>
                  ) : undefined
                }
              />
            ) : null}

            {rows.length > 0 ? (
              <ul className="tm-aut-scopes" aria-label={t('WebhookEndpointsScreen.listLabel')}>
                {rows.map((endpoint) => (
                  <li key={endpoint.id}>
                    <span className={`tm-aut-scope ${endpoint.enabled ? '' : 'tm-aut-scope--off'}`}>
                      {endpoint.enabled
                        ? t('WebhookEndpointsScreen.onShort')
                        : t('WebhookEndpointsScreen.offShort')}
                    </span>
                    <div className="tm-aut-list__main">
                      <span className="tm-aut-rowtitle tm-aut-url">{endpoint.url}</span>
                      <span className="tm-aut-rowsub">
                        {eventName(endpoint.eventKind)}{' '}
                        <span className="tm-aut-mono" dir="ltr">
                          {endpoint.eventKind}
                        </span>{' '}
                        &middot;{' '}
                        {endpoint.enabled
                          ? t('WebhookEndpointsScreen.enabled')
                          : t('WebhookEndpointsScreen.disabled')}
                      </span>
                    </div>
                    <div className="tm-aut-list__end">
                      <Link
                        href={`/${organizationSlug}/admin/automations/webhooks/${encodeURIComponent(endpoint.id)}/deliveries`}
                        className="tm-aut-btn"
                      >
                        {t('WebhookEndpointsScreen.deliveries')}
                      </Link>
                      <Button
                        type="button"
                        tone="outline"
                        size="compact"
                        loading={toggle.isPending && toggle.variables?.id === endpoint.id}
                        loadingLabel={t('WebhookEndpointsScreen.updating')}
                        onClick={() => toggle.mutate(endpoint)}
                      >
                        {endpoint.enabled
                          ? t('WebhookEndpointsScreen.disable')
                          : t('WebhookEndpointsScreen.enable')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section
            className="tm-aut-card tm-aut-card--strong"
            aria-labelledby="tm-webhook-new-heading"
          >
            <p className="tm-aut-eyebrow">{t('WebhookEndpointsScreen.newEndpointEyebrow')}</p>
            <h2 id="tm-webhook-new-heading" className="tm-aut-card__title">
              {t('WebhookEndpointsScreen.registerHeading')}
            </h2>
            <form
              ref={firstStep}
              className="tm-stack"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (canRegister) register.mutate();
              }}
            >
              <Field
                label={t('WebhookEndpointsScreen.urlLabel')}
                name="url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                hint={t('WebhookEndpointsScreen.urlHint')}
                required
              />

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-webhook-event">
                  {t('WebhookEndpointsScreen.event')}
                </label>
                <select
                  id="tm-webhook-event"
                  className="tm-field__control"
                  value={eventKind}
                  onChange={(event) => setEventKind(event.target.value as WebhookEventKind)}
                >
                  {WEBHOOK_EVENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {eventName(kind)}
                    </option>
                  ))}
                </select>
                <span className="tm-field__hint tm-aut-mono" dir="ltr">
                  {eventKind}
                </span>
              </div>

              <Field
                label={t('WebhookEndpointsScreen.secretLabel')}
                name="secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                hint={t('WebhookEndpointsScreen.secretHint')}
                required
              />

              {register.isError ? (
                <InlineAlert tone="danger" title={t('WebhookEndpointsScreen.registerError')} live>
                  {describeError(register.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-aut-actions">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={register.isPending}
                  loadingLabel={t('WebhookEndpointsScreen.registering')}
                  disabled={!canRegister}
                >
                  {t('WebhookEndpointsScreen.registerButton')}
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </ControlCenterShell>
  );
}
