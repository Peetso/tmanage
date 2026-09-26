'use client';

import { apiBaseUrl } from '../lib/api/browser-client';

/**
 * **CAL — ICS export (x128).** The download control for a meeting's calendar file.
 *
 * It links to `GET …/meetings/:meetingId/ics`, which renders the meeting as a read-only
 * `text/calendar` document behind `meeting.read` (an unknown or cross-tenant id is a 404 from the
 * API — the Known-trap order). A plain anchor, not a `fetch`, is the right control here: the
 * endpoint is a `GET` whose whole authentication is the same-site session cookie, and the API
 * already answers with `Content-Disposition: attachment`, so the browser saves the file. An anchor
 * with visible text carries its own accessible name — no `aria-label` gymnastics — so the control
 * is axe-clean by construction.
 *
 * The API origin is resolved from `NEXT_PUBLIC_API_BASE_URL` (via {@link apiBaseUrl}); tests pass
 * an explicit `baseUrl` so the component is exercised without the environment.
 */
export interface MeetingIcsButtonProps {
  organizationSlug: string;
  /** The meeting to export — carried in the route path. */
  meetingId: string;
  /** Test seam: the API origin. Defaults to the browser client's configured base URL. */
  baseUrl?: string;
}

export function MeetingIcsButton({ organizationSlug, meetingId, baseUrl }: MeetingIcsButtonProps) {
  const origin = baseUrl ?? apiBaseUrl();
  const href = `${origin}/v1/organizations/${encodeURIComponent(
    organizationSlug,
  )}/meetings/${encodeURIComponent(meetingId)}/ics`;

  return (
    <a
      className="tm-button tm-button--outline tm-button--default"
      href={href}
      download={`meeting-${meetingId}.ics`}
    >
      Export to calendar (.ics)
    </a>
  );
}
