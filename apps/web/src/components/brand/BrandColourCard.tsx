'use client';

import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, InlineAlert } from '@tmanage/ui';
import type { ApiClient } from '../../lib/api/client';
import { ApiRequestError } from '../../lib/api/errors';
import { getOrgBranding, updateOrgBranding } from '../../lib/api/org-branding';
import { TMANAGE_LIME, contrastRatio, normalizeHex, textOnAccent } from '../../lib/brand-accent';
import { useTOr } from '../../lib/i18n/use-t-or';
import { orgBrandingQueryKey } from './BrandAccentStyle';
import './brand-colour.css';

export interface BrandColourCardProps {
  readonly organizationSlug: string;
  readonly client: ApiClient;
  /** Only the company owner changes it; anyone else who can open the page sees it read-only. */
  readonly isOwner: boolean;
}

/**
 * **Brand colour** (Peter 2026-11-09). The owner replaces the TManage lime with the company's own
 * colour: a colour picker, a hex box, a live preview of a button and a Done chip with the text
 * colour picked for contrast, and "Reset to TManage lime". Saved on the organization's branding
 * (the product name and logo text it already holds are sent back unchanged).
 */
export function BrandColourCard({ organizationSlug, client, isOwner }: BrandColourCardProps) {
  const tOr = useTOr();
  const queries = useQueryClient();
  const titleId = useId();
  const pickerId = useId();
  const hexId = useId();
  const branding = useQuery({
    queryKey: orgBrandingQueryKey(organizationSlug),
    queryFn: () => getOrgBranding(client, organizationSlug),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const stored = branding.data?.updatedAt
    ? (normalizeHex(branding.data.accentColor) ?? TMANAGE_LIME)
    : TMANAGE_LIME;
  const [draft, setDraft] = useState(stored);
  const [hexText, setHexText] = useState(stored);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setDraft(stored);
    setHexText(stored);
  }, [stored]);

  const save = useMutation({
    mutationFn: (accentColor: string) =>
      updateOrgBranding(client, organizationSlug, {
        productName: branding.data?.productName ?? null,
        logoText: branding.data?.logoText ?? null,
        accentColor,
      }),
    onSuccess: (data) => {
      queries.setQueryData(orgBrandingQueryKey(organizationSlug), data);
      setSaved(true);
    },
  });

  const on = textOnAccent(draft);
  const ratio = contrastRatio(on, draft);
  const changed = draft !== stored;

  return (
    <section className="tm-brandcolour" aria-labelledby={titleId}>
      <h2 id={titleId} className="tm-brandcolour__title">
        {tOr('BrandColour.title', 'Brand colour')}
      </h2>
      <p className="tm-brandcolour__intro">
        {tOr(
          'BrandColour.intro',
          "Use your company's colour instead of the TManage lime. Buttons, the current item and Done work take it, for everyone in this workspace.",
        )}
      </p>

      <div className="tm-brandcolour__row">
        <label className="tm-brandcolour__label" htmlFor={pickerId}>
          {tOr('BrandColour.pick', 'Colour')}
        </label>
        <input
          id={pickerId}
          type="color"
          className="tm-brandcolour__picker"
          value={draft}
          disabled={!isOwner || save.isPending}
          onChange={(event) => {
            const value = event.target.value.toLowerCase();
            setSaved(false);
            setDraft(value);
            setHexText(value);
          }}
        />
        <label className="tm-visually-hidden" htmlFor={hexId}>
          {tOr('BrandColour.hex', 'Colour code')}
        </label>
        <input
          id={hexId}
          className="tm-brandcolour__hex"
          value={hexText}
          maxLength={7}
          spellCheck={false}
          disabled={!isOwner || save.isPending}
          onChange={(event) => {
            setSaved(false);
            setHexText(event.target.value);
            const hex = normalizeHex(event.target.value);
            if (hex !== null) setDraft(hex);
          }}
        />
      </div>

      <div
        className="tm-brandcolour__preview"
        role="group"
        aria-label={tOr('BrandColour.preview', 'Preview')}
      >
        <span className="tm-brandcolour__swatch" style={{ background: draft, color: on }}>
          {tOr('BrandColour.sampleButton', '+ New work')}
        </span>
        <span className="tm-brandcolour__swatch" style={{ background: draft, color: on }}>
          ✓ {tOr('WorkListScreen.stateDone', 'Done')}
        </span>
        <span className="tm-brandcolour__ratio">
          {tOr('BrandColour.contrast', 'Text contrast {ratio}:1').replace(
            '{ratio}',
            ratio.toFixed(1),
          )}
        </span>
      </div>

      {!isOwner ? (
        <p className="tm-brandcolour__intro">
          {tOr('BrandColour.ownerOnly', 'Only the company owner can change the brand colour.')}
        </p>
      ) : null}

      {save.isError ? (
        <InlineAlert tone="danger" live>
          {save.error instanceof ApiRequestError
            ? save.error.message
            : tOr('BrandColour.saveFailed', 'The colour was not saved. Try again.')}
        </InlineAlert>
      ) : null}
      {saved && !save.isPending ? (
        <p className="tm-brandcolour__saved" role="status">
          {tOr('BrandColour.saved', 'Saved. Everyone in the workspace now sees this colour.')}
        </p>
      ) : null}

      {isOwner ? (
        <div className="tm-brandcolour__actions">
          <Button
            tone="ink"
            loading={save.isPending}
            loadingLabel={tOr('BrandColour.saving', 'Saving')}
            disabled={!changed || normalizeHex(hexText) === null}
            onClick={() => save.mutate(draft)}
          >
            {tOr('BrandColour.save', 'Save colour')}
          </Button>
          <Button
            tone="outline"
            disabled={save.isPending || (stored === TMANAGE_LIME && draft === TMANAGE_LIME)}
            onClick={() => {
              setDraft(TMANAGE_LIME);
              setHexText(TMANAGE_LIME);
              save.mutate(TMANAGE_LIME);
            }}
          >
            {tOr('BrandColour.reset', 'Reset to TManage lime')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
