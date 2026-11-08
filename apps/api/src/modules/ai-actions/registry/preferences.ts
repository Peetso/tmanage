/**
 * AI action details — personal and notification preferences (the `me`, `notification-preferences`
 * and `preferences` surfaces).
 *
 * Slice S4 (registry wave C). All of these read or set the signed-in person's own settings, so the
 * bodies are bounded `config` blobs and results carry the `config` redaction profile. The personal
 * access token routes under `/me/personal-access-tokens` are NOT here: S4 moved them to the `NEVER`
 * deny-list, because an AI principal must never mint or read a credential (architecture B3).
 */
import { det, listArgs, bodyArgs, noArgs, pathOnly, f, type AiActionDetail } from './detail.js';

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
    description: 'Update your accessibility preferences.',
    input: bodyArgs([], { settings: f.config() }),
    redact: 'config',
    examples: [{ summary: 'Save', args: { settings: { reduceMotion: true } } }],
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
    description: 'Update your display preferences.',
    input: bodyArgs([], { settings: f.config() }),
    redact: 'config',
    examples: [{ summary: 'Dark mode', args: { settings: { theme: 'dark' } } }],
  }),
  det({
    id: 'me.doc_subscriptions.list',
    title: 'Your doc subscriptions',
    description: 'Documents you are subscribed to.',
    input: listArgs(),
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
    input: listArgs(),
    redact: 'standard',
    examples: [{ summary: 'Recent', args: { limit: 20 } }],
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
    description: 'Update your general preferences.',
    input: bodyArgs([], { settings: f.config() }),
    redact: 'config',
    examples: [{ summary: 'Save', args: { settings: {} } }],
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
    description: 'Override one keyboard shortcut.',
    input: bodyArgs(['actionKey'], { keys: f.shortText(60) }),
    redact: 'config',
    examples: [{ summary: 'Rebind', args: { actionKey: 'quick_add', keys: 'mod+k' } }],
  }),
  det({
    id: 'me.shortcuts.delete',
    title: 'Reset a shortcut',
    description: 'Remove a shortcut override. Confirm-class.',
    input: pathOnly('actionKey'),
    redact: 'config',
    examples: [{ summary: 'Reset', args: { actionKey: 'quick_add' } }],
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
    input: bodyArgs([], { view: f.shortText(60) }),
    redact: 'config',
    examples: [{ summary: 'Home', args: { view: 'home' } }],
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
    description: 'Change your overall notification preferences.',
    input: bodyArgs([], { settings: f.config() }),
    redact: 'config',
    examples: [{ summary: 'Save', args: { settings: { email: false } } }],
  }),
  det({
    id: 'notification_preferences.kinds.list',
    title: 'Notification kinds',
    description: 'Per-kind notification settings.',
    input: listArgs(),
    redact: 'config',
    examples: [{ summary: 'Read', args: {} }],
  }),
  det({
    id: 'notification_preferences.kinds.set',
    title: 'Set a notification kind',
    description: 'Turn one kind of notification on or off, per channel.',
    input: bodyArgs(['kind'], { channels: f.config() }),
    redact: 'config',
    examples: [
      { summary: 'Mute mentions email', args: { kind: 'mention', channels: { email: false } } },
    ],
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
    description: 'Change your email-digest preferences.',
    input: bodyArgs([], { settings: f.config() }),
    redact: 'config',
    examples: [{ summary: 'Daily', args: { settings: { frequency: 'daily' } } }],
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
    description: 'Update your quiet-hours window.',
    input: bodyArgs([], { settings: f.config() }),
    redact: 'config',
    examples: [{ summary: 'Evenings', args: { settings: { start: '18:00', end: '09:00' } } }],
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
