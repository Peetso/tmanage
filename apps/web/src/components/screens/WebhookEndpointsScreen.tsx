'use client';

import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  listWebhookEndpoints,
  registerWebhookEndpoint,
  setWebhookEndpointEnabled,
  WEBHOOK_EVENT_KINDS,
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

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title="Webhooks"
      description="Register outbound webhook endpoints your automations will call. Delivery is validated here; dispatch is a later step."
    >
      <section className="tm-panel tm-stack" aria-labelledby="tm-webhook-new-heading">
        <h2 id="tm-webhook-new-heading" className="tm-eyebrow">
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
                  {kind}
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

          <div className="tm-row">
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

      <section
        className="tm-panel tm-panel--quiet tm-stack"
        aria-labelledby="tm-webhook-list-heading"
      >
        <h2 id="tm-webhook-list-heading" className="tm-eyebrow">
          Endpoints
        </h2>

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
          <InlineAlert tone="neutral" title="No endpoints yet">
            Register an endpoint above to receive automation events.
          </InlineAlert>
        ) : null}

        {rows.length > 0 ? (
          <ul className="tm-list tm-stack" aria-label="Webhook endpoints">
            {rows.map((endpoint) => (
              <li key={endpoint.id} className="tm-stack tm-stack--tight">
                <div className="tm-row tm-row--wrap">
                  <span className="tm-mono">{endpoint.url}</span>
                  <Button
                    type="button"
                    tone="outline"
                    size="accessible"
                    className="tm-push-end"
                    loading={toggle.isPending && toggle.variables?.id === endpoint.id}
                    loadingLabel="Updating"
                    onClick={() => toggle.mutate(endpoint)}
                  >
                    {endpoint.enabled ? 'Disable' : 'Enable'}
                  </Button>
                </div>
                <p className="tm-field__hint">
                  {endpoint.eventKind} &middot; {endpoint.enabled ? 'Enabled' : 'Disabled'}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </AppShell>
  );
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof NetworkError) return 'The API did not answer. Is it running?';
  return 'Something went wrong. Try again.';
}
