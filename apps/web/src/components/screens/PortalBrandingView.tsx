'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  ACCENT_COLOR_PATTERN,
  getPortalBranding,
  savePortalBranding,
} from '../../lib/api/portal-branding';
import type { PortalBranding } from '../../lib/api/portal-branding';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';

export interface PortalBrandingViewProps {
  organizationSlug: string;
  /** The client organization whose client-facing branding this editor sets. */
  clientOrganizationId: string;
  client?: ApiClient | undefined;
}

/** The defaults an unbranded client reads by; the same values the API's `DEFAULT_PORTAL_BRANDING` holds. */
const DEFAULTS = { accentColor: '#2563eb', welcomeHeading: '', welcomeText: '' } as const;
const MAX_HEADING = 200;
const MAX_TEXT = 2000;

/**
 * **Client portal branding (module 13 Client portal, x323).**
 *
 * `38-MODULE-MAP` §Client Portal (per-client branding), `22-SCREEN` §Portal home. A staff manager sets
 * one client organization's client-facing theme — an accent colour (a `#RGB`/`#RRGGBB` hex) and the
 * welcome heading and text — then saves. Persisted behind `client_member.manage`, tenant-scoped by the
 * server and keyed per client organization; the client portal home reads these presentation fields
 * (never who last edited them) to theme the client-facing surface. Text and colour only — no logo
 * upload this slice.
 */
export function PortalBrandingView({
  organizationSlug,
  clientOrganizationId,
  client,
}: PortalBrandingViewProps) {
  const api = client ?? browserApiClient();
  const queries = useQueryClient();

  const branding = useQuery({
    queryKey: ['portal-branding', organizationSlug, clientOrganizationId],
    queryFn: () => getPortalBranding(api, organizationSlug, clientOrganizationId),
  });

  const [accentColor, setAccentColor] = useState<string>(DEFAULTS.accentColor);
  const [welcomeHeading, setWelcomeHeading] = useState<string>(DEFAULTS.welcomeHeading);
  const [welcomeText, setWelcomeText] = useState<string>(DEFAULTS.welcomeText);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!branding.data) return;
    setAccentColor(branding.data.accentColor);
    setWelcomeHeading(branding.data.welcomeHeading ?? '');
    setWelcomeText(branding.data.welcomeText ?? '');
  }, [branding.data]);

  // Client-side mirror of the server's accent allowlist, so a malformed value is caught before the PUT.
  const accentValid = ACCENT_COLOR_PATTERN.test(accentColor);

  const save = useMutation({
    mutationFn: (): Promise<PortalBranding> =>
      savePortalBranding(api, organizationSlug, clientOrganizationId, {
        accentColor,
        welcomeHeading: welcomeHeading.trim() === '' ? null : welcomeHeading.trim(),
        welcomeText: welcomeText.trim() === '' ? null : welcomeText.trim(),
      }),
    onSuccess: (result) => {
      queries.setQueryData(['portal-branding', organizationSlug, clientOrganizationId], result);
      setSaved(true);
    },
  });

  if (branding.isPending) {
    return (
      <LoadingRegion label="Loading portal branding">
        <Skeleton />
      </LoadingRegion>
    );
  }

  if (branding.isError) {
    return (
      <InlineAlert tone="danger" title="We could not load the portal branding">
        {errorMessage(branding.error)}
      </InlineAlert>
    );
  }

  return (
    <form
      className="tm-panel tm-stack"
      aria-labelledby="tm-portal-branding-heading"
      onSubmit={(event) => {
        event.preventDefault();
        if (!accentValid) return;
        setSaved(false);
        save.mutate();
      }}
    >
      <h2 id="tm-portal-branding-heading" className="tm-eyebrow">
        Client portal branding
      </h2>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor="tm-branding-accent">
          Accent colour
        </label>
        <input
          id="tm-branding-accent"
          className="tm-field__control"
          type="text"
          value={accentColor}
          placeholder="#2563eb"
          aria-invalid={!accentValid}
          onChange={(event) => setAccentColor(event.target.value)}
        />
        {!accentValid ? (
          <p className="tm-field__error">Enter a #RGB or #RRGGBB hex colour.</p>
        ) : null}
      </div>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor="tm-branding-heading-input">
          Welcome heading
        </label>
        <input
          id="tm-branding-heading-input"
          className="tm-field__control"
          type="text"
          maxLength={MAX_HEADING}
          value={welcomeHeading}
          placeholder="Shown at the top of the client portal"
          onChange={(event) => setWelcomeHeading(event.target.value)}
        />
      </div>

      <div className="tm-field">
        <label className="tm-field__label" htmlFor="tm-branding-text">
          Welcome text
        </label>
        <textarea
          id="tm-branding-text"
          className="tm-field__control"
          rows={3}
          maxLength={MAX_TEXT}
          value={welcomeText}
          placeholder="A short message for this client"
          onChange={(event) => setWelcomeText(event.target.value)}
        />
      </div>

      {save.isError ? (
        <InlineAlert tone="danger" title="We could not save the portal branding">
          {errorMessage(save.error)}
        </InlineAlert>
      ) : null}

      {saved && !save.isPending && !save.isError ? (
        <InlineAlert tone="success" title="Saved">
          The client portal branding has been saved.
        </InlineAlert>
      ) : null}

      <div>
        <Button type="submit" disabled={save.isPending || !accentValid}>
          {save.isPending ? 'Saving…' : 'Save branding'}
        </Button>
      </div>
    </form>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
