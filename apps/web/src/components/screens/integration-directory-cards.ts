import type { BrandId } from '../brand/BrandLogo';

/**
 * The Integrations page's cards (feedback 2026-11-09 item 6), in the order an owner meets them.
 *
 * - `oauth`: TManage has the provider's sign-in. "Connect" starts it: the API returns the
 *   provider's consent address and the browser goes there in the same click.
 * - `page`: connected another way (an access token, an API key, a channel link). "Set up" opens the
 *   page that does it.
 * - `soon`: no flow yet. The card says so; nothing pretends to connect it.
 *
 * `what` is the English line under the name; `whatKey` is its catalog key (read with `tOr`, so a
 * key not merged yet still shows the English).
 */
export type IntegrationCardId =
  | 'google-drive'
  | 'onedrive'
  | 'google-calendar'
  | 'outlook'
  | 'figma'
  | 'github'
  | 'slack'
  | 'teams'
  | 'zapier';

export interface IntegrationCard {
  readonly id: IntegrationCardId;
  readonly brand: BrandId;
  readonly flow: 'oauth' | 'page' | 'soon';
  /** Company storage and tools for everyone, or the owner's own calendar. */
  readonly scope: 'company' | 'personal';
  readonly whatKey: string;
  readonly what: string;
  /** For `page` cards: where it is set up, after `/{org}`. For `oauth` cards: where it is managed. */
  readonly path?: string;
}

export const INTEGRATION_CARDS: readonly IntegrationCard[] = [
  {
    id: 'google-drive',
    brand: 'google-drive',
    flow: 'oauth',
    scope: 'company',
    whatKey: 'ConnectApps.app.googleDrive.what',
    what: "Keep your company's files in your own Google Drive.",
    path: '/admin/storage',
  },
  {
    id: 'onedrive',
    brand: 'onedrive',
    flow: 'oauth',
    scope: 'company',
    whatKey: 'ConnectApps.app.onedrive.what',
    what: "Keep your company's files in your own OneDrive.",
    path: '/admin/storage',
  },
  {
    id: 'google-calendar',
    brand: 'google-calendar',
    flow: 'oauth',
    scope: 'personal',
    whatKey: 'ConnectApps.app.googleCalendar.what',
    what: 'Your TManage meetings show up in your Google Calendar, with a Meet link.',
    path: '/settings/calendar-connections',
  },
  {
    id: 'outlook',
    brand: 'outlook',
    flow: 'oauth',
    scope: 'personal',
    whatKey: 'ConnectApps.app.microsoftCalendar.what',
    what: 'Your TManage meetings show up in your Outlook calendar.',
    path: '/settings/calendar-connections',
  },
  {
    id: 'figma',
    brand: 'figma',
    flow: 'page',
    scope: 'company',
    whatKey: 'IntegrationDirectoryScreen.what.figma',
    what: 'Show Figma frames on work items and reviews, always up to date.',
    path: '/settings/connected-apps#tm-figma-connect',
  },
  {
    id: 'github',
    brand: 'github',
    flow: 'page',
    scope: 'company',
    whatKey: 'IntegrationDirectoryScreen.what.github',
    what: 'Link pull requests and commits to the work they belong to.',
    path: '/settings/connected-apps',
  },
  {
    id: 'slack',
    brand: 'slack',
    flow: 'page',
    scope: 'company',
    whatKey: 'IntegrationDirectoryScreen.what.slack',
    what: 'Post TManage notices to a Slack channel.',
    path: '/settings/channel-notices',
  },
  {
    id: 'teams',
    brand: 'teams',
    flow: 'page',
    scope: 'company',
    whatKey: 'IntegrationDirectoryScreen.what.teams',
    what: 'Post TManage notices to a Microsoft Teams channel.',
    path: '/settings/channel-notices',
  },
  {
    id: 'zapier',
    brand: 'zapier',
    flow: 'soon',
    scope: 'company',
    whatKey: 'IntegrationDirectoryScreen.what.zapier',
    what: 'Start Zapier flows when something happens in TManage.',
  },
];

/** The headline: "Nothing connected yet", "One connected", "{count} connected" in other locales. */
export function connectedTitle(
  count: number,
  tr: (key: string, english: string) => string,
  english: boolean,
  locale: string,
  word: (count: number) => string,
): string {
  if (count === 0) return tr('IntegrationDirectoryScreen.titleNothing', 'Nothing connected yet');
  if (english) {
    const text = `${word(count)} connected`;
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return tr('IntegrationDirectoryScreen.titleConnected', '{count} connected').replace(
    '{count}',
    new Intl.NumberFormat(locale).format(count),
  );
}
