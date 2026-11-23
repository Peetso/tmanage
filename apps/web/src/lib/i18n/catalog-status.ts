import type { DisplayLocale } from '../api/display-preferences';

/**
 * R12 / R2 — which interface languages the pickers offer, and how far each catalog has got.
 *
 * `DISPLAY_LOCALES` (the API allowlist) is wider than what a person may pick: `ja-JP` stays valid
 * on the wire (a saved value must keep loading) but has no catalog, so no picker lists it. The
 * five newer catalogs ship as `beta` (machine-assisted, one worker per language); a native-speaker
 * review flips one to `reviewed`, and `i18n-key-parity.test.ts` then holds it to the strict rule
 * Arabic already meets.
 */

/** The locales every language picker lists, in this order. `ja-JP` is allowlisted but hidden. */
export const OFFERED_LOCALES = [
  'en-US',
  'en-GB',
  'ar-EG',
  'es-ES',
  'fr-FR',
  'pt-BR',
  'de-DE',
  'zh-CN',
  // Slice 54-21: Urdu, right-to-left (Figma "54-21 · Urdu (ur-PK) locale" 577:32841).
  'ur-PK',
] as const satisfies readonly DisplayLocale[];

export type OfferedLocale = (typeof OFFERED_LOCALES)[number];

/** The catalog languages besides English (the source of truth), by `t.ts`'s catalog name. */
export type CatalogName = 'ar' | 'es' | 'fr' | 'pt-BR' | 'de' | 'zh-CN' | 'ur';

/**
 * `partial` (slice 54-21, Urdu): a beta catalog that covers only the core namespaces
 * ({@link PARTIAL_CORE_NAMESPACES}) and leaves every other key to the English fallback in `t.ts`.
 * The pickers mark it "Beta" like any beta catalog; the parity test holds it to no stray key, no
 * empty value, no lost placeholder and a complete core, but not to the 1 % missing-key cap.
 */
export type CatalogStatus = 'reviewed' | 'beta' | 'partial';

export const CATALOG_STATUS: Readonly<Record<CatalogName, CatalogStatus>> = {
  ar: 'reviewed',
  es: 'beta',
  fr: 'beta',
  'pt-BR': 'beta',
  de: 'beta',
  'zh-CN': 'beta',
  ur: 'partial',
};

/**
 * The namespaces (the key prefix before the first `.`) a `partial` catalog must translate in full:
 * the shell, sign-in, My Day, projects, work, chat and settings.
 */
export const PARTIAL_CORE_NAMESPACES: readonly string[] = [
  // Shell
  'shell',
  'Shell',
  'nav',
  'AccountMenu',
  'LanguagePicker',
  'LocaleHint',
  'IdleSignOut',
  'WorkspaceSuspendedGate',
  'NewProjectLink',
  'ProjectFavoritesSwitcher',
  // Sign-in
  'signIn',
  'SignInScreen',
  'CompanySignIn',
  'PasskeySignIn',
  'AuthRefusal',
  // My Day
  'MyDayScreen',
  'MyDay',
  'HomeBriefing',
  // Projects
  'ProjectOverviewScreen',
  'ProjectTabs',
  'ProjectMilestones',
  'Overview',
  'ActivityFeed',
  'ActivityTab',
  // Work
  'WorkListScreen',
  'WorkActions',
  'WorkItemType',
  'DeleteWorkItem',
  'WorkBulkActionBar',
  'WorkCommentsPanel',
  // Chat
  'ChatScreen',
  'ChatList',
  'ChatSidebar',
  'ChatStatus',
  'ChatMedia',
  'ChatWorkspaces',
  'ChannelBrowser',
  'MessageActionsSheet',
  'MessageBookmark',
  'PinnedMessagesView',
  'SavedMessagesScreen',
  'NewMessageDialog',
  'DirectMessageScreen',
  // Settings
  'Preferences',
  'PreferencesScreen',
  'DisplayPreferencesView',
  'displayPreferences',
  'displayPrefs',
  'orgSettings',
  'OrgSettings',
  'AlertSettings',
];

/** Each language named in itself, as every picker shows it (Figma "Languages (R2)" 501:29247). */
const NATIVE_NAMES: Readonly<Record<OfferedLocale, string>> = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'ar-EG': 'العربية',
  'es-ES': 'Español',
  'fr-FR': 'Français',
  'pt-BR': 'Português (Brasil)',
  'de-DE': 'Deutsch',
  'zh-CN': '简体中文',
  'ur-PK': 'اردو',
};

/** The language's own name for an offered locale; any other value is returned as it is. */
export function localeNativeName(locale: string): string {
  return Object.prototype.hasOwnProperty.call(NATIVE_NAMES, locale)
    ? NATIVE_NAMES[locale as OfferedLocale]
    : locale;
}

/** The `lang` attribute a native name is written in (`zh-CN` → `zh`, `pt-BR` → `pt`). */
export function localeLangAttribute(locale: string): string {
  return (locale.split('-')[0] ?? 'en').toLowerCase();
}

/** Whether the picker marks this locale "Beta" (its catalog is not reviewed yet, or partial). */
export function isBetaLocale(locale: string): boolean {
  const name = catalogNameOf(locale);
  return name !== 'en' && CATALOG_STATUS[name] !== 'reviewed';
}

/** The catalog a BCP-47 locale reads from: ar, es, fr, pt → pt-BR, de, zh → zh-CN, ur, else en. */
export function catalogNameOf(locale: string): CatalogName | 'en' {
  switch ((locale.split('-')[0] ?? '').toLowerCase()) {
    case 'ar':
      return 'ar';
    case 'es':
      return 'es';
    case 'fr':
      return 'fr';
    case 'pt':
      return 'pt-BR';
    case 'de':
      return 'de';
    case 'zh':
      return 'zh-CN';
    case 'ur':
      return 'ur';
    default:
      return 'en';
  }
}
