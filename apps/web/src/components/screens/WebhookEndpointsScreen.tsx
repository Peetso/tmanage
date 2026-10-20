'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { ControlCenterSections } from '../admin/ControlCenterShell';
import { AppShell } from '../shell/AppShell';
import '../../styles/screens/automations.css';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listWebhookEndpoints,
  registerWebhookEndpoint,
  setWebhookEndpointEnabled,
  WEBHOOK_EVENT_KINDS,
  webhookEventLabel,
  type WebhookEndpointSummary,
  type WebhookEventKind,
} from '../../lib/api/webhooks';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

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
  const api = client ?? browserApiClient();
  const queryClient = useQueryClient();

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
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="admin"
      contextRail={
        <ControlCenterSections organizationSlug={organizationSlug} section="integrations" />
      }
      eyebrow="Control center · Integrations · Webhooks"
      title="Webhooks"
      {...(rows.length > 0
        ? {
            titleMeta: `${rows.length} endpoint${rows.length === 1 ? '' : 's'} · ${enabledCount} on`,
          }
        : {})}
      description="Register the https endpoints your automations call. Each one keeps a log of its delivery attempts."
      actions={
        <Link href={`/${organizationSlug}/automations/apps`} className="tm-aut-btn">
          All integrations
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
                Endpoints
              </h2>
              {rows.length > 0 ? (
                <span className="tm-aut-mono">
                  {rows.length} registered · {enabledCount} on
                </span>
              ) : null}
            </div>

            {toggle.isError ? (
              <InlineAlert tone="danger" title="Could not update the endpoint" live>
                {describeError(toggle.error)}
              </InlineAlert>
            ) : null}

            {endpoints.isError ? (
              <InlineAlert tone="danger" title="Could not load the endpoints" live>
                {describeError(endpoints.error)}
              </InlineAlert>
            ) : null}

            {endpoints.isPending ? (
              <LoadingRegion label="Loading the endpoints.">
                <Skeleton height="var(--row)" />
                <Skeleton height="var(--row)" />
              </LoadingRegion>
            ) : null}

            {!endpoints.isPending && !endpoints.isError && rows.length === 0 ? (
              <div className="tm-aut-empty tm-aut-empty--flush">
                <p className="tm-aut-empty__title">No endpoints yet</p>
                <p className="tm-aut-empty__body">
                  Register an endpoint to receive automation events.
                </p>
              </div>
            ) : null}

            {rows.length > 0 ? (
              <ul className="tm-aut-scopes" aria-label="Webhook endpoints">
                {rows.map((endpoint) => (
                  <li key={endpoint.id}>
                    <span className={`tm-aut-scope ${endpoint.enabled ? '' : 'tm-aut-scope--off'}`}>
                      {endpoint.enabled ? 'On' : 'Off'}
                    </span>
                    <div className="tm-aut-list__main">
                      <span className="tm-aut-rowtitle tm-aut-url">{endpoint.url}</span>
                      <span className="tm-aut-rowsub">
                        {webhookEventLabel(endpoint.eventKind)} &middot;{' '}
                        {endpoint.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                    <div className="tm-aut-list__end">
                      <Link
                        href={`/${organizationSlug}/admin/automations/webhooks/${encodeURIComponent(endpoint.id)}/deliveries`}
                        className="tm-aut-btn"
                      >
                        Deliveries
                      </Link>
                      <Button
                        type="button"
                        tone="outline"
                        size="compact"
                        loading={toggle.isPending && toggle.variables?.id === endpoint.id}
                        loadingLabel="Updating"
                        onClick={() => toggle.mutate(endpoint)}
                      >
                        {endpoint.enabled ? 'Disable' : 'Enable'}
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
            <p className="tm-aut-eyebrow">New endpoint · signed delivery</p>
            <h2 id="tm-webhook-new-heading" className="tm-aut-card__title">
              Register an endpoint
            </h2>
            <form
              className="tm-stack"
              noValidate
              onSubmit={(event: FormEvent<HTMLFormElement>) => {
                event.preventDefault();
                if (canRegister) register.mutate();
              }}
            >
              <Field
                label="Endpoint URL"
                name="url"
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                hint="Must be an https URL on a public host. Localhost and private addresses are rejected."
                required
              />

              <div className="tm-field">
                <label className="tm-field__label" htmlFor="tm-webhook-event">
                  Event
                </label>
                <select
                  id="tm-webhook-event"
                  className="tm-field__control"
                  value={eventKind}
                  onChange={(event) => setEventKind(event.target.value as WebhookEventKind)}
                >
                  {WEBHOOK_EVENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {webhookEventLabel(kind)}
                    </option>
                  ))}
                </select>
              </div>

              <Field
                label="Signing secret"
                name="secret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                hint="At least 16 characters. Stored as a hash and never shown again after you save it."
                required
              />

              {register.isError ? (
                <InlineAlert tone="danger" title="Could not register the endpoint" live>
                  {describeError(register.error)}
                </InlineAlert>
              ) : null}

              <div className="tm-aut-actions">
                <Button
                  type="submit"
                  tone="ink"
                  size="accessible"
                  loading={register.isPending}
                  loadingLabel="Registering"
                  disabled={!canRegister}
                >
                  Register endpoint
                </Button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
