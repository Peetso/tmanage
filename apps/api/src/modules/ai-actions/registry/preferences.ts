/**
 * AI action details — personal and notification preferences (the `me`, `notification-preferences`
 * and `preferences` surfaces).
 *
 * Slice S4 (registry wave C). All of these read or set the signed-in person's own settings, and
 * results carry the `config` redaction profile. Each PUT body is the route's own fixed field set
 * (DC-9, fix lane B 2026-11-23): the vocabularies are imported from where the route reads them. The
 * personal access token routes under `/me/personal-access-tokens` are NOT here: S4 moved them to the
 * `NEVER` deny-list, because an AI principal must never mint or read a credential (architecture B3).
 */
import { z } from 'zod';
import { DICTATION_LANGUAGE_TAGS, isValidTimeZone } from '@tmanage/domain';
import {
  det,
  queryArgs,
  listArgs,
  bodyArgs,
  noArgs,
  pathOnly,
  f,
  type AiActionDetail,
} from './detail.js';
import {
  A11Y_FONT_SCALES,
  DENSITY_PREFERENCES,
  DIGEST_CADENCE,
  DIGEST_FREQUENCIES,
  DISPLAY_DATE_FORMATS,
  DISPLAY_DENSITIES,
  DISPLAY_LOCALES,
  DISPLAY_THEMES,
  LANDING_KEYS,
  NOTIFICATION_KINDS,
  PREFERENCE_LOCALES,
  THEME_PREFERENCES,
} from '../../../common/database/schema.js';
import { isIanaTimeZone } from '../../../common/time-zone.js';
import {
  DISPLAY_CALENDARS,
  DISPLAY_NUMERALS,
  DISPLAY_WEEK_STARTS,
} from '../../preferences/display-prefs.service.js';
import { isKnownActionKey, isValidChord } from '../../preferences/shortcut-prefs.service.js';
import { UI_MODES } from '../../tenancy/org-settings.allowlist.js';

/** = quiet-hours.controller.ts TIME_PATTERN (not exported): HH:MM, 24-hour. */
const hhmm = () =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .describe('HH:MM, 24-hour');
/** = notification-preferences.controller.ts TIME_OF_DAY (not exported): HH:MM or HH:MM:SS. */
const timeOfDay = () =>
  z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
    .describe('HH:MM or HH:MM:SS, 24-hour');
const isUnset = (value: unknown): boolean => value === undefined || value === null;
const ianaZone = (check: (v: string) => boolean) =>
  z
    .string()
    .min(1)
    .max(64)
    .refine(check, 'must be a valid IANA time zone')
    .describe('IANA time zone, e.g. Asia/Riyadh');

export const preferencesDetails: readonly AiActionDetail[] = [
  // me.* (self preferences)
  det({
    id: 'me.accessibility.list',
    title: 'Accessibility settings',
    description: 'Your accessibility preferences.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'me.accessibility.set',
    title: 'Set accessibility settings',
    description:
      'Replace your accessibility preferences: text size, reduced motion, high contrast.',
    // = preferences/a11y-preferences.ts `parseA11yPreferences`: all three, no other key.
    input: bodyArgs([], {
      fontScale: z.enum(A11Y_FONT_SCALES),
      reduceMotion: f.bool(),
      highContrast: f.bool(),
    }),
    redact: 'config',
    examples: [
      { summary: 'Save', args: { fontScale: 'lg', reduceMotion: true, highContrast: false } },
    ],
  }),
  det({
    id: 'me.display_preferences.list',
    title: 'Display preferences',
    description: 'Your display preferences (theme, density).',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'me.display_preferences.set',
    title: 'Set display preferences',
    description:
      'Replace your display preferences. theme, density, locale, timezone and dateFormat are ' +
      'required (read the current ones with me.display_preferences.list); the rest keep their ' +
      'defaults when left out.',
    // = preferences/display-prefs.service.ts `parseInput`: a fixed key set.
    input: bodyArgs([], {
      theme: z.enum(DISPLAY_THEMES),
      density: z.enum(DISPLAY_DENSITIES),
      locale: z.enum(DISPLAY_LOCALES),
      timezone: ianaZone(isIanaTimeZone),
      dateFormat: z.enum(DISPLAY_DATE_FORMATS),
      numerals: z.enum(DISPLAY_NUMERALS).optional(),
      calendarDisplay: z.enum(DISPLAY_CALENDARS).optional(),
      weekStart: z.enum(DISPLAY_WEEK_STARTS).optional(),
      uiMode: z.enum(UI_MODES).optional(),
      dictationLanguage: z.enum(DICTATION_LANGUAGE_TAGS).nullable().optional(),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Dark mode',
        args: {
          theme: 'dark',
          density: 'comfortable',
          locale: 'en-US',
          timezone: 'Asia/Riyadh',
          dateFormat: 'iso',
        },
      },
    ],
  }),
  det({
    id: 'me.doc_subscriptions.list',
    title: 'Your doc subscriptions',
    description: 'Documents you are subscribed to.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  // 53-15: the member's own kind × channel matrix; one cell per set.
  det({
    id: 'me.notification_matrix.list',
    title: 'Notification matrix',
    description: 'Your notification kinds by channel (in-app, e-mail, digest).',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'me.notification_matrix.set',
    title: 'Set a notification matrix cell',
    description: 'Turn one kind of notification on or off for one channel.',
    input: bodyArgs([], {
      kind: f.id(40),
      channel: f.id(16),
      enabled: f.bool(),
    }),
    redact: 'config',
    examples: [
      { summary: 'Digest files', args: { kind: 'file', channel: 'digest', enabled: true } },
    ],
  }),
  det({
    id: 'me.mentions.list',
    title: 'Your mentions',
    description: 'Places where you were mentioned.',
    input: listArgs([], {}, { limit: false, cursor: 'page' }),
    redact: 'standard',
    examples: [{ summary: 'Recent', args: {} }],
  }),
  det({
    id: 'me.preferences.list',
    title: 'Your preferences',
    description: 'Your general preferences.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'me.preferences.set',
    title: 'Set your preferences',
    description: 'Replace your general preferences: theme, language and density (all three).',
    // = preferences/preferences.controller.ts `parsePreferences`.
    input: bodyArgs([], {
      theme: z.enum(THEME_PREFERENCES),
      locale: z.enum(PREFERENCE_LOCALES),
      density: z.enum(DENSITY_PREFERENCES),
    }),
    redact: 'config',
    examples: [{ summary: 'Save', args: { theme: 'dark', locale: 'en', density: 'compact' } }],
  }),
  det({
    id: 'me.profile.list',
    title: 'Your profile',
    description: 'Your name, sign-in email (read-only) and job title in this workspace.',
    input: noArgs(),
    redact: 'people',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'me.profile.set',
    title: 'Update your profile',
    description: 'Change your own name and job title. The sign-in email cannot be changed here.',
    input: bodyArgs([], { displayName: f.shortText(190), jobTitle: f.shortText(120).nullish() }),
    redact: 'people',
    examples: [
      { summary: 'Rename', args: { displayName: 'Mona Saleh', jobTitle: 'Art director' } },
    ],
  }),
  det({
    id: 'me.shortcuts.list',
    title: 'Your shortcuts',
    description: 'Your keyboard-shortcut overrides.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'me.shortcuts.set',
    title: 'Set a shortcut',
    description:
      'Override one keyboard shortcut. actionKey is a command-palette action from ' +
      'me.shortcuts.list; chord is modifiers (Ctrl, Alt, Shift, Meta) plus one key, e.g. Ctrl+K.',
    // = preferences/shortcut-prefs.service.ts `isKnownActionKey` / `isValidChord`.
    input: bodyArgs(['actionKey'], {
      actionKey: f.id().refine(isKnownActionKey, 'must be a known command-palette action'),
      chord: z
        .string()
        .max(64)
        .refine(isValidChord, 'must be zero or more modifiers plus one key (e.g. Ctrl+K)'),
    }),
    redact: 'config',
    examples: [{ summary: 'Rebind', args: { actionKey: 'act-search', chord: 'Ctrl+Shift+K' } }],
  }),
  det({
    id: 'me.shortcuts.delete',
    title: 'Reset a shortcut',
    description: 'Remove a shortcut override. Confirm-class.',
    input: pathOnly('actionKey'),
    redact: 'config',
    examples: [{ summary: 'Reset', args: { actionKey: 'act-search' } }],
  }),
  det({
    id: 'me.startup.list',
    title: 'Your startup view',
    description: 'Which screen opens when you sign in.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'me.startup.set',
    title: 'Set your startup view',
    description: 'Choose which screen opens on sign-in.',
    // = preferences/startup-prefs.service.ts `parseStartupInput`.
    input: bodyArgs([], { landingKey: z.enum(LANDING_KEYS) }),
    redact: 'config',
    examples: [{ summary: 'Home', args: { landingKey: 'home' } }],
  }),
  // notification preferences
  det({
    id: 'notification_preferences.list',
    title: 'Notification preferences',
    description: 'Your overall notification settings.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'notification_preferences.set',
    title: 'Set notification preferences',
    description:
      'Replace your overall notification preferences: in-app and e-mail on or off, digest ' +
      'frequency, and an optional quiet window (start and end together, or neither).',
    // = notifications/notification-preferences.controller.ts `parseInput`.
    input: (
      bodyArgs([], {
        inAppEnabled: f.bool(),
        emailEnabled: f.bool(),
        digestFrequency: z.enum(DIGEST_FREQUENCIES),
        quietHoursStart: timeOfDay().nullable().optional(),
        quietHoursEnd: timeOfDay().nullable().optional(),
        quietHoursTimezone: ianaZone(isValidTimeZone).nullable().optional(),
      }) as z.ZodObject<z.ZodRawShape>
    ).refine(
      (v: Record<string, unknown>) => isUnset(v['quietHoursStart']) === isUnset(v['quietHoursEnd']),
      { message: 'quiet hours need both a start and an end, or neither', path: ['quietHoursEnd'] },
    ),
    redact: 'config',
    examples: [
      {
        summary: 'Save',
        args: { inAppEnabled: true, emailEnabled: false, digestFrequency: 'daily' },
      },
    ],
  }),
  det({
    id: 'notification_preferences.kinds.list',
    title: 'Notification kinds',
    description: 'Per-kind notification settings.',
    input: queryArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'notification_preferences.kinds.set',
    title: 'Set a notification kind',
    description: 'Turn one kind of notification on or off for you.',
    // = notifications/notification-kind-prefs.controller.ts `set`.
    input: bodyArgs(['kind'], { kind: z.enum(NOTIFICATION_KINDS), enabled: f.bool() }),
    redact: 'config',
    examples: [{ summary: 'Mute mentions', args: { kind: 'mention', enabled: false } }],
  }),
  // preferences module
  det({
    id: 'preferences.digest.list',
    title: 'Digest settings',
    description: 'Your email-digest settings.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'preferences.digest.set',
    title: 'Set digest settings',
    description:
      'Replace your e-mail digest settings: cadence, send hour (0-23) and day of week (0-6, ' +
      'Sunday 0), and the optional business briefing.',
    // = preferences/digest.controller.ts `parseInput`.
    input: bodyArgs([], {
      cadence: z.enum(DIGEST_CADENCE),
      sendHour: f.int(0, 23),
      dayOfWeek: f.int(0, 6),
      businessBriefing: f.bool().optional(),
    }),
    redact: 'config',
    examples: [{ summary: 'Daily', args: { cadence: 'daily', sendHour: 8, dayOfWeek: 1 } }],
  }),
  det({
    id: 'preferences.quiet_hours.list',
    title: 'Quiet hours',
    description: 'Your quiet-hours settings.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'preferences.quiet_hours.set',
    title: 'Set quiet hours',
    description:
      'Replace your quiet-hours window: on or off, start and end (HH:MM), time zone, and the ' +
      'weekdays it applies to (0-6, Sunday 0).',
    // = preferences/quiet-hours.controller.ts `parseInput`.
    input: bodyArgs([], {
      enabled: f.bool(),
      startTime: hhmm(),
      endTime: hhmm(),
      timezone: ianaZone(isIanaTimeZone),
      days: z
        .array(f.int(0, 6))
        .max(7)
        .refine((d) => new Set(d).size === d.length, 'days must not repeat'),
    }),
    redact: 'config',
    examples: [
      {
        summary: 'Evenings',
        args: {
          enabled: true,
          startTime: '18:00',
          endTime: '09:00',
          timezone: 'Asia/Riyadh',
          days: [0, 1, 2, 3, 4],
        },
      },
    ],
  }),
  det({
    id: 'preferences.quiet_hours.active.list',
    title: 'Quiet hours active?',
    description: 'Whether quiet hours are active right now.',
    input: noArgs(),
    redact: 'config',
    examples: [{ summary: 'Check', args: {} }],
  }),
];
