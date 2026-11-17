'use client';

import { InlineAlert } from '@tmanage/ui';
import { useT } from '../../lib/i18n/use-t';

/** The id of a service's paused line, for the buttons that point at it. */
function pausedLineId(service: string): string {
  return `tm-service-paused-${service}`;
}

/**
 * ADMINSVC2 — what a workspace sees when a connected service is switched off for the platform:
 * the existing calm notice, not an error. Shown wherever {@link isServicePaused} matches.
 */
export function ServicePausedNotice({ service }: { readonly service: string }) {
  const t = useT();
  return (
    <InlineAlert tone="neutral" title={t('platformServices.pausedTitle')} live>
      <span id={pausedLineId(service)}>{t('platformServices.pausedBody')}</span>
    </InlineAlert>
  );
}

/**
 * ADMINSVC3 — a Connect / Reconnect button of a paused service: the design system's native
 * disabled state (as the sibling disabled buttons), with the paused line as its description so a
 * screen reader announces why. Nothing for a service that is not paused.
 */
export function pausedButtonProps(
  service: string,
  paused: boolean,
): { readonly disabled?: true; readonly 'aria-describedby'?: string } {
  return paused ? { disabled: true, 'aria-describedby': pausedLineId(service) } : {};
}
