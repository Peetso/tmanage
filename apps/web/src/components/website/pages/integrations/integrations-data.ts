/**
 * 54-02 Integrations content, truth-in-copy (Figma 443:20507 EN / 443:20899 AR). Three groups:
 * what works in TManage today, what connects with the customer's own account, and what is only
 * planned. A card is listed under "Works today" or "Connect with your own account" only when the
 * product really does it; an own-account connector stays off the page until it ships
 * (`shipped: true`). Dropbox and Deploy hooks are not offered and are not listed.
 *
 * Copy keys are new (merged from the 54-02 i18n fragment), so every key carries its English text
 * for `useTOr`. Brand names stay Latin in every language and have no key.
 */

export type IntegrationGroupId = 'today' | 'own-account' | 'planned';

export interface Integration {
  id: string;
  /** Brand or product name, shown as-is in every language. */
  name: string;
  /** A translated name for the generic ones ("Webhooks"); brand names have none. */
  nameKey?: string;
  lineKey: string;
  line: string;
  group: IntegrationGroupId;
  /** Own-account connectors only: true once the connector is live in the product. */
  shipped?: boolean;
}

const K = 'IntegrationsPage.truth.';

export const INTEGRATIONS: readonly Integration[] = [
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    lineKey: `${K}lineGoogleCalendar`,
    line: 'Due dates and meetings appear in your own calendar.',
    group: 'today',
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    lineKey: `${K}lineGoogleDrive`,
    line: 'Keep project files in your own Drive.',
    group: 'today',
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    lineKey: `${K}lineOneDrive`,
    line: 'Keep project files in your own OneDrive.',
    group: 'today',
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    nameKey: `${K}nameWebhooks`,
    lineKey: `${K}lineWebhooks`,
    line: 'Send events to your own systems when work changes.',
    group: 'today',
  },
  {
    id: 'rest-api',
    name: 'REST API',
    lineKey: `${K}lineRestApi`,
    line: 'Read and update your work from your own code.',
    group: 'today',
  },
  {
    id: 'mcp-server',
    name: 'MCP server',
    nameKey: `${K}nameMcpServer`,
    lineKey: `${K}lineMcpServer`,
    line: 'Let your AI assistant work in TManage, with your approval.',
    group: 'today',
  },
  {
    id: 'personal-access-tokens',
    name: 'Personal access tokens',
    nameKey: `${K}namePersonalAccessTokens`,
    lineKey: `${K}linePersonalAccessTokens`,
    line: 'Create keys for scripts and tools, and revoke them any time.',
    group: 'today',
  },
  {
    id: 'slack',
    name: 'Slack',
    lineKey: `${K}lineSlack`,
    line: 'Post updates to a Slack channel with your own link.',
    group: 'own-account',
    shipped: false,
  },
  {
    id: 'microsoft-teams',
    name: 'Microsoft Teams',
    lineKey: `${K}lineTeams`,
    line: 'Post updates to a Teams channel with your own link.',
    group: 'own-account',
    shipped: false,
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp',
    lineKey: `${K}lineWhatsApp`,
    line: 'Send notices from your own WhatsApp Business number.',
    group: 'own-account',
    shipped: false,
  },
  {
    id: 'figma',
    name: 'Figma',
    lineKey: `${K}lineFigma`,
    line: 'Paste a Figma link to show a live preview on a task.',
    group: 'own-account',
    shipped: false,
  },
  {
    id: 'github',
    name: 'GitHub',
    lineKey: `${K}lineGitHub`,
    line: 'Link code changes and pull requests to your tasks.',
    group: 'own-account',
    shipped: false,
  },
  {
    id: 'zapier-make-n8n',
    name: 'Zapier · Make · n8n',
    lineKey: `${K}lineAutomation`,
    line: 'Connect thousands of apps through webhooks.',
    group: 'own-account',
    shipped: false,
  },
  {
    id: 'saml-sso',
    name: 'SAML single sign-on',
    nameKey: `${K}nameSaml`,
    lineKey: `${K}lineSaml`,
    line: 'Sign in with your company identity provider.',
    group: 'planned',
  },
  {
    id: 'scim',
    name: 'SCIM provisioning',
    nameKey: `${K}nameScim`,
    lineKey: `${K}lineScim`,
    line: 'Add and remove people automatically from your directory.',
    group: 'planned',
  },
  {
    id: 'inbound-email',
    name: 'Inbound email',
    nameKey: `${K}nameInboundEmail`,
    lineKey: `${K}lineInboundEmail`,
    line: 'Turn emails into requests and tasks.',
    group: 'planned',
  },
  {
    id: 'data-region',
    name: 'Data region choice',
    nameKey: `${K}nameDataRegion`,
    lineKey: `${K}lineDataRegion`,
    line: 'Choose where your data is stored.',
    group: 'planned',
  },
  {
    id: 'self-host',
    name: 'Self-host',
    nameKey: `${K}nameSelfHost`,
    lineKey: `${K}lineSelfHost`,
    line: 'Run TManage on your own servers.',
    group: 'planned',
  },
];

export interface IntegrationGroup {
  id: IntegrationGroupId;
  titleKey: string;
  title: string;
  ledeKey: string;
  lede: string;
  badge: { key: string; text: string; tone: 'client' | 'mono' | 'neutral' };
}

export const INTEGRATION_GROUPS: readonly IntegrationGroup[] = [
  {
    id: 'today',
    titleKey: `${K}groupTodayTitle`,
    title: 'Works today',
    ledeKey: `${K}groupTodayLede`,
    lede: 'Live in TManage now, on every plan.',
    badge: { key: `${K}badgeAvailable`, text: 'Available', tone: 'client' },
  },
  {
    id: 'own-account',
    titleKey: `${K}groupOwnTitle`,
    title: 'Connect with your own account',
    ledeKey: `${K}groupOwnLede`,
    lede: 'Paste your own link or key. No extra app to install.',
    badge: { key: `${K}badgeBeta`, text: 'Beta', tone: 'mono' },
  },
  {
    id: 'planned',
    titleKey: `${K}groupPlannedTitle`,
    title: 'Planned',
    ledeKey: `${K}groupPlannedLede`,
    lede: 'Not built yet. Tell us you need it and we will let you know when it ships.',
    badge: { key: `${K}badgePlanned`, text: 'Planned', tone: 'neutral' },
  },
];

/** The cards a group shows: an own-account connector only once it has shipped. */
export function cardsOf(
  group: IntegrationGroupId,
  items: readonly Integration[] = INTEGRATIONS,
): Integration[] {
  return items.filter(
    (item) => item.group === group && (item.group !== 'own-account' || item.shipped === true),
  );
}

/** The contact-lead message a "Tell us you need it" request carries: its tag, nothing else. */
export function integrationRequestMessage(id: string): string {
  return `integration_request:${id}`;
}
