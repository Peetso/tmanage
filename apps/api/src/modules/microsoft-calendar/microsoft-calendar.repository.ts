import { GoogleCalendarRepository } from '../google-calendar/google-calendar.repository.js';

/**
 * 0237 (slice B). A person's Outlook calendar connection. `calendar_connections` is
 * provider-generic (one row per organization, person and provider), so the queries are the
 * Google slice's, called with `provider = 'microsoft'`: every one carries `organization_id`, and a
 * person reads and writes only their own row except where a meeting's organizer's connection is
 * looked up to push that meeting. Kept as its own class so a Microsoft-only query has a home.
 */
export class MicrosoftCalendarRepository extends GoogleCalendarRepository {}
