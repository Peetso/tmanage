'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Field, InlineAlert } from '@tmanage/ui';
import { browserApiClient } from '../../../lib/api/browser-client';
import { ApiRequestError } from '../../../lib/api/errors';
import {
  SUPPORT_DEFAULT_MINUTES,
  SUPPORT_DURATIONS,
  startSupportSession,
} from '../../../lib/api/platform-support';
import { useT } from '../../../lib/i18n/use-t';
import type { MessageKey } from '../../../lib/i18n/t';
import {
  PLATFORM_ME_QUERY_KEY,
  STEP_UP_MIN_SECONDS,
  usePlatformPermissions,
} from '../shared/usePlatformPermissions';
import { StepUpForm } from '../shared/platform-kit';
import {
  PlatformDialog,
  PlatformDialogActions,
  REASON_MAX,
  platformErrorText,
} from '../shared/ReasonDialog';
import { rememberSupportSession } from './support-session-memory';
import './support-mode.css';

const DURATION_LABEL: Record<(typeof SUPPORT_DURATIONS)[number], MessageKey> = {
  30: 'SupportMode.duration30',
  120: 'SupportMode.duration120',
  480: 'SupportMode.duration480',
};

/**
 * "Enter {org} in Support mode" (435:14175): what Support mode does, the length (30 min, 2 hours,
 * 8 hours), an optional reason, and the note that owners see the visit in their own audit log.
 * Entering needs a live step-up; a lapsed one shows the step-up form first.
 */
export function SupportSessionEnterDialog({
  organizationId,
  organizationName,
  onClose,
}: {
  organizationId: string;
  organizationName: string;
  onClose: () => void;
}) {
  const t = useT();
  const api = browserApiClient();
  const queryClient = useQueryClient();
  const permissions = usePlatformPermissions(api);
  const [minutes, setMinutes] = useState<number>(SUPPORT_DEFAULT_MINUTES);
  const [reason, setReason] = useState('');
  const needsStepUp =
    permissions.me !== undefined && permissions.stepUpRemainingSeconds < STEP_UP_MIN_SECONDS;

  const enter = useMutation({
    mutationFn: () =>
      startSupportSession(api, organizationId, {
        minutes,
        reason: reason.trim() === '' ? null : reason.trim(),
      }),
    onSuccess: (started) => {
      rememberSupportSession(started.slug, started.id);
      window.location.assign(started.redirectTo);
    },
    onError: async (error) => {
      if (error instanceof ApiRequestError && error.code === 'reauthentication_required') {
        await queryClient.invalidateQueries({ queryKey: PLATFORM_ME_QUERY_KEY });
      }
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (needsStepUp) return;
    enter.mutate();
  }

  const admin = permissions.me?.displayName ?? permissions.me?.email ?? '';

  return (
    <PlatformDialog
      title={t('SupportMode.enterTitle').replace('{org}', organizationName)}
      onClose={onClose}
    >
      <form className="tm-stack" onSubmit={submit} noValidate>
        <ul className="tm-support-dialog__points">
          <li>{t('SupportMode.point1').replace('{org}', organizationName)}</li>
          <li>{t('SupportMode.point2')}</li>
          <li>{t('SupportMode.point3').replace('{admin}', admin)}</li>
        </ul>
        <fieldset className="tm-support-dialog__durations" role="radiogroup">
          <legend>{t('SupportMode.duration')}</legend>
          {SUPPORT_DURATIONS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={minutes === value}
              className="tm-support-dialog__duration"
              onClick={() => setMinutes(value)}
            >
              {t(DURATION_LABEL[value])}
            </button>
          ))}
        </fieldset>
        <Field
          label={t('SupportMode.reasonLabel')}
          hint={t('SupportMode.reasonHint')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={REASON_MAX}
        />
        <p className="tm-support-dialog__owners-note">
          <span aria-hidden="true">!</span>
          <span>{t('SupportMode.ownersNote')}</span>
        </p>
        {needsStepUp && permissions.me ? <StepUpForm api={api} me={permissions.me} /> : null}
        {enter.isError ? (
          <InlineAlert tone="danger" title={t('SupportMode.enterFailed')} live>
            {platformErrorText(enter.error, t)}
          </InlineAlert>
        ) : null}
        <PlatformDialogActions>
          <Button type="button" tone="outline" onClick={onClose}>
            {t('SupportMode.cancel')}
          </Button>
          <Button type="submit" tone="ink" disabled={enter.isPending || needsStepUp}>
            {t('SupportMode.enter')}
          </Button>
        </PlatformDialogActions>
      </form>
    </PlatformDialog>
  );
}
