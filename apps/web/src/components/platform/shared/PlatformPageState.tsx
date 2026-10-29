'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, InlineAlert, LoadingRegion, Skeleton } from '@tmanage/ui';
import type { ApiClient } from '../../../lib/api/client';
import { ApiRequestError } from '../../../lib/api/errors';
import type { PlatformMeView } from '../../../lib/api/platform-admin';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import { StepUpForm } from './platform-kit';
import { platformErrorText } from './ReasonDialog';

export type PlatformPageStateKind = 'loading' | 'empty' | 'error' | 'forbidden' | 'step-up';

export interface PlatformPageStateProps {
  state: PlatformPageStateKind;
  /** `error`: what failed (its message and correlation id are shown). */
  error?: unknown;
  /** `forbidden`: the missing permission key, e.g. `platform.settings.edit`. */
  permission?: string | null;
  /** `forbidden`: the viewer's preset, for "You are a Support admin". */
  preset?: PlatformMeView['preset'] | null;
  /** `empty`/`error`: a heading; defaults per state. */
  title?: ReactNode;
  /** `empty`: the sentence under the heading. */
  body?: ReactNode;
  /** `error`: Try again. */
  onRetry?: () => void;
  /** `step-up`: the step-up form needs the client and `me`. */
  api?: ApiClient;
  me?: PlatformMeView;
  /** `loading`: what is loading, for assistive tech. */
  loadingLabel?: string;
}

const PRESET_KEYS: Record<PlatformMeView['preset'], MessageKey> = {
  super_admin: 'PlatformShared.presetSuperAdmin',
  support: 'PlatformShared.presetSupport',
  auditor: 'PlatformShared.presetAuditor',
  custom: 'PlatformShared.presetCustom',
};

export function presetLabel(preset: PlatformMeView['preset'], t: ReturnType<typeof useT>): string {
  return t(PRESET_KEYS[preset]);
}

/**
 * The page states every Platform admin screen shares (frames 433:10706 step-up, 434:15036 error /
 * 403 / step-up, 435:15341 step-up + 403). No loading frame was drawn: loading is the Control
 * Center's skeleton rows.
 */
export function PlatformPageState(props: PlatformPageStateProps) {
  const t = useT();
  const { state } = props;

  if (state === 'loading') {
    return (
      <LoadingRegion
        label={props.loadingLabel ?? t('PlatformShared.loading')}
        className="tm-stack tm-stack--tight"
      >
        <Skeleton height="var(--row)" />
        <Skeleton height="var(--row)" />
        <Skeleton height="var(--row)" />
      </LoadingRegion>
    );
  }

  if (state === 'step-up') {
    if (!props.api || !props.me) return null;
    return <StepUpForm api={props.api} me={props.me} />;
  }

  if (state === 'empty') {
    return (
      <section className="tm-cc-card tm-stack tm-stack--tight">
        <h2 className="tm-cc-card__title">{props.title ?? t('PlatformShared.emptyTitle')}</h2>
        {props.body ? <p className="tm-cc-note">{props.body}</p> : null}
      </section>
    );
  }

  if (state === 'forbidden') {
    const permission = props.permission ?? '';
    return (
      <section className="tm-cc-card tm-stack tm-stack--tight" data-state="forbidden">
        <p className="tm-cc-eyebrow">{t('PlatformShared.forbiddenEyebrow')}</p>
        <h2 className="tm-cc-card__title">{props.title ?? t('PlatformShared.forbiddenTitle')}</h2>
        <p className="tm-cc-note">
          {props.preset
            ? `${t('PlatformShared.forbiddenYouAre')} ${presetLabel(props.preset, t)}. `
            : ''}
          {t('PlatformShared.forbiddenBody')}
        </p>
        {permission !== '' ? (
          <InlineAlert tone="danger">
            {t('PlatformShared.missingPermission')} <bdi dir="ltr">{permission}</bdi>
          </InlineAlert>
        ) : null}
        <div>
          <Link href="/platform/team" className="tm-button tm-button--outline tm-button--default">
            {t('PlatformShared.openTeam')}
          </Link>
        </div>
      </section>
    );
  }

  // error
  const correlationId =
    props.error instanceof ApiRequestError && props.error.correlationId !== ''
      ? props.error.correlationId
      : null;
  return (
    <section className="tm-cc-card tm-stack tm-stack--tight" data-state="error">
      <p className="tm-cc-eyebrow">{t('PlatformShared.errorEyebrow')}</p>
      <InlineAlert tone="danger" title={props.title ?? t('PlatformShared.errorTitle')} live>
        {platformErrorText(props.error, t)}
      </InlineAlert>
      <div className="tm-cc-hero__actions" style={{ justifyContent: 'space-between' }}>
        {correlationId ? (
          <span className="tm-cc-cell-sub">
            {t('PlatformShared.correlation')} <bdi dir="ltr">{correlationId}</bdi>
          </span>
        ) : (
          <span />
        )}
        {props.onRetry ? (
          <Button type="button" tone="ink" onClick={props.onRetry}>
            {t('PlatformShared.tryAgain')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
