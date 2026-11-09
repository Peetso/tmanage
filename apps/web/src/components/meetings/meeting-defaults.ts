/**
 * Settings › Calendar connections › "Defaults for new meetings". A per-person convenience kept
 * in this browser only (no server setting exists): the New meeting form starts from it. Every
 * read and write tolerates storage being unavailable.
 */

export interface MeetingDefaults {
  readonly provider: 'google' | 'microsoft' | null;
  readonly conference: 'google_meet' | 'teams' | 'none' | null;
  readonly reminderMinutes: number;
}

const KEY = 'tm-meeting-defaults';
export const FALLBACK_DEFAULTS: MeetingDefaults = {
  provider: null,
  conference: null,
  reminderMinutes: 10,
};

export function readMeetingDefaults(): MeetingDefaults {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return FALLBACK_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<MeetingDefaults>;
    return {
      provider:
        parsed.provider === 'google' || parsed.provider === 'microsoft' ? parsed.provider : null,
      conference:
        parsed.conference === 'google_meet' ||
        parsed.conference === 'teams' ||
        parsed.conference === 'none'
          ? parsed.conference
          : null,
      reminderMinutes:
        typeof parsed.reminderMinutes === 'number' && parsed.reminderMinutes >= 0
          ? parsed.reminderMinutes
          : 10,
    };
  } catch {
    return FALLBACK_DEFAULTS;
  }
}

export function writeMeetingDefaults(defaults: MeetingDefaults): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(defaults));
  } catch {
    // Private mode or blocked storage: the defaults just do not stick.
  }
}

/** The video call each calendar makes: Google Calendar makes Meet links, Outlook makes Teams. */
export function conferenceFor(provider: 'google' | 'microsoft'): 'google_meet' | 'teams' {
  return provider === 'microsoft' ? 'teams' : 'google_meet';
}

/**
 * The defaults as they apply now, given the calendars that are connected. A saved calendar that
 * is no longer connected gives way to the first connected one, and the video call follows the
 * calendar: a Meet default with Outlook as the destination (or Teams with Google) cannot be met,
 * so it becomes the destination's own video call. "No video call" is always kept.
 */
export function effectiveMeetingDefaults(
  defaults: MeetingDefaults,
  connected: readonly ('google' | 'microsoft')[],
): MeetingDefaults {
  const provider =
    defaults.provider !== null && connected.includes(defaults.provider)
      ? defaults.provider
      : (connected[0] ?? null);
  const conference =
    defaults.conference === 'none'
      ? 'none'
      : provider === null
        ? defaults.conference
        : conferenceFor(provider);
  return { ...defaults, provider, conference };
}
