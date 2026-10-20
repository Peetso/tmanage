'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import {
  ORG_BRANDING_ACCENT_PATTERN,
  getOrgBranding,
  updateOrgBranding,
} from '../../lib/api/org-branding';
import type { OrgBrandingView as OrgBrandingRecord } from '../../lib/api/org-branding';
import { ApiRequestError, NetworkError } from '../../lib/api/errors';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';

export interface OrgBrandingViewProps {
  organizationSlug: string;
  organizationName: string;
  client?: ApiClient;
}

const PRODUCT_NAME_MAX_LENGTH = 120;
const LOGO_TEXT_MAX_LENGTH = 48;

/** The defaults an unconfigured studio reads by; the same values the API's `DEFAULT_ORG_BRANDING` holds. */
const DEFAULTS = {
  productName: '',
  accentColor: '#2563eb',
  logoText: '',
} as const;

/**
 * **Org branding (Administration, module 18, x327).**
 *
 * `38-MODULE-MAP` §Administration (org identity), `22-SCREEN` §Administration settings. An org admin
 * sets org-wide branding — the display product name, an accent colour, and a short logo text /
 * initials — applied to the internal app chrome. Persisted behind `org.manage` (set), tenant-scoped by
 * the server; any member reads it (`work.read`) to render the shell. Text and colour only — no file
 * upload this slice.
 */
export function OrgBrandingView({
  organizationSlug,
  organizationName,
  client,
}: OrgBrandingViewProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const queries = useQueryClient();

  const branding = useQuery({
    queryKey: ['org-branding', organizationSlug],
    queryFn: () => getOrgBranding(api, organizationSlug),
  });

  const [productName, setProductName] = useState<string>(DEFAULTS.productName);
  const [accentColor, setAccentColor] = useState<string>(DEFAULTS.accentColor);
  const [logoText, setLogoText] = useState<string>(DEFAULTS.logoText);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!branding.data) return;
    setProductName(branding.data.productName ?? '');
    setAccentColor(branding.data.accentColor);
    setLogoText(branding.data.logoText ?? '');
  }, [branding.data]);

  const accentValid = ORG_BRANDING_ACCENT_PATTERN.test(accentColor);

  const save = useMutation({
    mutationFn: (): Promise<OrgBrandingRecord> =>
      updateOrgBranding(api, organizationSlug, {
        productName: productName.trim() === '' ? null : productName.trim(),
        accentColor,
        logoText: logoText.trim() === '' ? null : logoText.trim(),
      }),
    onSuccess: (result) => {
      queries.setQueryData(['org-branding', organizationSlug], result);
      setSaved(true);
    },
  });

  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      title={t('OrgBrandingView.title')}
      description={t('OrgBrandingView.description')}
    >
      {branding.isPending ? (
        <LoadingRegion label={t('OrgBrandingView.loading')}>
          <Skeleton />
        </LoadingRegion>
      ) : branding.isError ? (
        <InlineAlert tone="danger" title={t('OrgBrandingView.loadError')}>
          {errorMessage(branding.error)}
        </InlineAlert>
      ) : (
        <form
          className="tm-panel tm-stack"
          aria-labelledby="tm-org-branding-heading"
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            save.mutate();
          }}
        >
          <h2 id="tm-org-branding-heading" className="tm-eyebrow">
            {t('OrgBrandingView.chromeBranding')}
          </h2>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-org-product-name">
              {t('OrgBrandingView.productName')}
            </label>
            <input
              id="tm-org-product-name"
              className="tm-field__control"
              type="text"
              maxLength={PRODUCT_NAME_MAX_LENGTH}
              value={productName}
              placeholder={t('OrgBrandingView.productNamePlaceholder')}
              onChange={(event) => setProductName(event.target.value)}
            />
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-org-accent">
              {t('OrgBrandingView.accentColour')}
            </label>
            <input
              id="tm-org-accent"
              className="tm-field__control"
              type="text"
              value={accentColor}
              placeholder="#2563eb"
              aria-invalid={!accentValid}
              onChange={(event) => setAccentColor(event.target.value)}
            />
            {!accentValid ? (
              <p className="tm-field__hint" role="alert">
                {t('OrgBrandingView.accentHint')}
              </p>
            ) : null}
          </div>

          <div className="tm-field">
            <label className="tm-field__label" htmlFor="tm-org-logo-text">
              {t('OrgBrandingView.logoText')}
            </label>
            <input
              id="tm-org-logo-text"
              className="tm-field__control"
              type="text"
              maxLength={LOGO_TEXT_MAX_LENGTH}
              value={logoText}
              placeholder={t('OrgBrandingView.logoTextPlaceholder')}
              onChange={(event) => setLogoText(event.target.value)}
            />
          </div>

          {save.isError ? (
            <InlineAlert tone="danger" title={t('OrgBrandingView.saveError')}>
              {errorMessage(save.error)}
            </InlineAlert>
          ) : null}

          {saved && !save.isPending && !save.isError ? (
            <InlineAlert tone="success" title={t('OrgBrandingView.savedTitle')}>
              {t('OrgBrandingView.savedBody')}
            </InlineAlert>
          ) : null}

          <div>
            <Button type="submit" disabled={save.isPending || !accentValid}>
              {save.isPending ? t('OrgBrandingView.saving') : t('OrgBrandingView.saveBranding')}
            </Button>
          </div>
        </form>
      )}
    </AppShell>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError || error instanceof NetworkError) return error.message;
  return 'Something went wrong. Please try again.';
}
