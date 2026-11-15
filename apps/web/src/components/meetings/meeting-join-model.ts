import type {
  MeetingAttendanceStatus,
  MeetingCallProvider,
  MeetingCallView,
} from '../../lib/api/meeting-join';

/**
 * 53-12 — what the meeting page says about the call, as plain data (no React): the state capsule,
 * the provider's name, and whether Join is pressable. The API decides who may join and when; this
 * only words its answer.
 */

export type JoinCapsule =
  | { readonly key: 'startsIn'; readonly minutes: number }
  | { readonly key: 'opensAt'; readonly at: string }
  | { readonly key: 'inProgress'; readonly since: string }
  | { readonly key: 'ended' }
  | { readonly key: 'upcoming' };

export function joinCapsule(
  call: Pick<MeetingCallView, 'joinState' | 'opensAt'>,
  startsAt: string,
  now: Date,
): JoinCapsule {
  const start = Date.parse(startsAt);
  if (call.joinState === 'ended') return { key: 'ended' };
  if (call.joinState === 'not_open') return { key: 'opensAt', at: call.opensAt };
  if (now.getTime() < start) {
    return { key: 'startsIn', minutes: Math.max(1, Math.ceil((start - now.getTime()) / 60_000)) };
  }
  return { key: 'inProgress', since: startsAt };
}

const PROVIDER_NAMES: Readonly<Record<MeetingCallProvider, string>> = {
  google_meet: 'Google Meet',
  teams: 'Microsoft Teams',
  zoom: 'Zoom',
  webex: 'Webex',
  whereby: 'Whereby',
  jitsi: 'Jitsi',
};

export function providerName(provider: MeetingCallProvider | null): string {
  return provider ? PROVIDER_NAMES[provider] : '';
}

/** Join is pressable for an invited person inside the window, when the meeting has a call. */
export function canJoin(call: MeetingCallView | undefined): boolean {
  return !!call && call.invited && call.kind !== null && call.joinState === 'open';
}

/** The pill tone the attendance row borrows from the RSVP pills. */
export function attendanceTone(status: MeetingAttendanceStatus): string {
  return status === 'present'
    ? 'accepted'
    : status === 'late'
      ? 'tentative'
      : status === 'absent'
        ? 'declined'
        : 'invited';
}

/** `HH:MM` in the viewer's locale, or an em dash. */
export function clock(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(
    new Date(iso),
  );
}
