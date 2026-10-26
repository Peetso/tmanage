'use client';

import Link from 'next/link';
import { AppShell } from '../shell/AppShell';
import { browserApiClient } from '../../lib/api/browser-client';
import type { ApiClient } from '../../lib/api/client';
import { useT } from '../../lib/i18n/use-t';
import { MeetingForm } from './MeetingForm';
import { useCalendarAccounts } from './use-meetings-data';

export interface MeetingFormScreenProps {
  organizationSlug: string;
  organizationName: string;
  meetingId?: string;
  initialProjectId?: string;
  client?: ApiClient;
}

/**
 * The New / Edit meeting page (approved Figma 417:9827): "Calendar · New meeting" over the title,
 * Cancel and "Save and send invitations" at the header's end (they submit the form below).
 */
export function MeetingFormScreen({
  organizationSlug,
  organizationName,
  meetingId,
  initialProjectId,
  client,
}: MeetingFormScreenProps) {
  const api = client ?? browserApiClient();
  const t = useT();
  const { accounts } = useCalendarAccounts(api, organizationSlug);
  const sends = accounts.some((a) => a.status === 'connected');
  const editing = meetingId !== undefined;
  const back = editing
    ? `/${organizationSlug}/calendar/meetings/${encodeURIComponent(meetingId)}`
    : `/${organizationSlug}/calendar`;
  return (
    <AppShell
      organizationSlug={organizationSlug}
      organizationName={organizationName}
      activeNavigationId="calendar"
      title={editing ? t('MeetingForm.editTitle') : t('MeetingForm.newTitle')}
      eyebrow={`${t('MeetingForm.eyebrowCalendar')} · ${
        editing ? t('MeetingForm.editTitle') : t('MeetingForm.newTitle')
      }`.toUpperCase()}
      actions={
        <div className="tm-mtg-header-actions">
          <Link className="tm-mtg-btn tm-mtg-btn--outline tm-mtg-btn--tall" href={back}>
            {t('MeetingForm.cancel')}
          </Link>
          <button
            type="submit"
            form="tm-mtg-form"
            className="tm-mtg-btn tm-mtg-btn--ink tm-mtg-btn--tall"
          >
            {sends ? t('MeetingForm.saveAndSend') : t('MeetingForm.save')}
          </button>
        </div>
      }
    >
      <MeetingForm
        organizationSlug={organizationSlug}
        client={api}
        {...(meetingId ? { meetingId } : {})}
        {...(initialProjectId ? { initialProjectId } : {})}
      />
    </AppShell>
  );
}
