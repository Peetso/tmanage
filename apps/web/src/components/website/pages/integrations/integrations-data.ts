import type { MessageKey } from '../../../../lib/i18n/t';

/**
 * WEB-13 Integrations content (Figma "T-Manage Website" frame 308:38). Every status is "Planned"
 * until engineering confirms a connection is live — the spec's honesty rule, not a placeholder.
 * Copy lives in the i18n catalog; brand names stay Latin in every language.
 */

export type IntegrationCategory = 'calendar' | 'files' | 'identity' | 'developer' | 'ai' | 'email';

export interface IntegrationFilter {
  id: 'all' | IntegrationCategory;
  labelKey: MessageKey;
}

export const INTEGRATION_FILTERS: readonly IntegrationFilter[] = [
  { id: 'all', labelKey: 'IntegrationsPage.catAll' },
  { id: 'calendar', labelKey: 'IntegrationsPage.catCalendar' },
  { id: 'files', labelKey: 'IntegrationsPage.catFiles' },
  { id: 'identity', labelKey: 'IntegrationsPage.catIdentity' },
  { id: 'developer', labelKey: 'IntegrationsPage.catDeveloper' },
  { id: 'ai', labelKey: 'IntegrationsPage.catAi' },
];

export const CATEGORY_LABEL_KEY: Record<IntegrationCategory, MessageKey> = {
  calendar: 'IntegrationsPage.catCalendar',
  files: 'IntegrationsPage.catFiles',
  identity: 'IntegrationsPage.catIdentity',
  developer: 'IntegrationsPage.catDeveloper',
  ai: 'IntegrationsPage.catAi',
  email: 'IntegrationsPage.catEmail',
};

/** One line per category, as the design repeats it on every card of that category. */
export const CATEGORY_LINE_KEY: Record<IntegrationCategory, MessageKey> = {
  calendar: 'IntegrationsPage.lineCalendar',
  files: 'IntegrationsPage.lineFiles',
  identity: 'IntegrationsPage.lineIdentity',
  developer: 'IntegrationsPage.lineDeveloper',
  ai: 'IntegrationsPage.lineAi',
  email: 'IntegrationsPage.lineEmail',
};

export interface Integration {
  id: string;
  /** Brand or product name, shown as-is in every language. */
  name: string;
  /** A translated name for the generic ones ("Inbound email"); brand names have none. */
  nameKey?: MessageKey;
  category: IntegrationCategory;
  status: 'available' | 'planned';
}

export const INTEGRATIONS: readonly Integration[] = [
  { id: 'google-calendar', name: 'Google Calendar', category: 'calendar', status: 'planned' },
  { id: 'microsoft-365', name: 'Microsoft 365', category: 'calendar', status: 'planned' },
  { id: 'google-drive', name: 'Google Drive', category: 'files', status: 'planned' },
  { id: 'onedrive', name: 'OneDrive', category: 'files', status: 'planned' },
  { id: 'dropbox', name: 'Dropbox', category: 'files', status: 'planned' },
  { id: 'saml-sso', name: 'SAML SSO', category: 'identity', status: 'planned' },
  { id: 'scim', name: 'SCIM', category: 'identity', status: 'planned' },
  {
    id: 'webhooks',
    name: 'Webhooks',
    nameKey: 'IntegrationsPage.nameWebhooks',
    category: 'developer',
    status: 'planned',
  },
  {
    id: 'deploy-hooks',
    name: 'Deploy hooks',
    nameKey: 'IntegrationsPage.nameDeployHooks',
    category: 'developer',
    status: 'planned',
  },
  { id: 'rest-api', name: 'REST API', category: 'developer', status: 'planned' },
  {
    id: 'mcp-server',
    name: 'MCP server',
    nameKey: 'IntegrationsPage.nameMcpServer',
    category: 'ai',
    status: 'planned',
  },
  {
    id: 'inbound-email',
    name: 'Inbound email',
    nameKey: 'IntegrationsPage.nameInboundEmail',
    category: 'email',
    status: 'planned',
  },
];

/**
 * The cards a filter and a search leave on screen. `textOf` returns every visible string of a
 * card (its name, line and category, in the active language), so a search matches what the
 * reader sees; the English brand name always matches too.
 */
export function filterIntegrations(
  items: readonly Integration[],
  filter: IntegrationFilter['id'],
  query: string,
  textOf: (item: Integration) => readonly string[],
): Integration[] {
  const q = query.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (filter === 'all' || item.category === filter) &&
      (q === '' ||
        [item.name, ...textOf(item)].some((text) => text.toLocaleLowerCase().includes(q))),
  );
}

export interface ConnectionStep {
  titleKey: MessageKey;
  bodyKey: MessageKey;
}

export const CONNECTION_STEPS: readonly ConnectionStep[] = [
  { titleKey: 'IntegrationsPage.step1Title', bodyKey: 'IntegrationsPage.step1Body' },
  { titleKey: 'IntegrationsPage.step2Title', bodyKey: 'IntegrationsPage.step2Body' },
  { titleKey: 'IntegrationsPage.step3Title', bodyKey: 'IntegrationsPage.step3Body' },
];

export interface DeveloperLink {
  title: string;
  titleKey?: MessageKey;
  hintKey: MessageKey;
}

/** "Build your own" link cards; each opens the developer guide. */
export const DEVELOPER_LINKS: readonly DeveloperLink[] = [
  {
    title: 'Webhooks',
    titleKey: 'IntegrationsPage.nameWebhooks',
    hintKey: 'IntegrationsPage.devWebhooksHint',
  },
  { title: 'REST API', hintKey: 'IntegrationsPage.devRestHint' },
  {
    title: 'Deploy hooks',
    titleKey: 'IntegrationsPage.nameDeployHooks',
    hintKey: 'IntegrationsPage.devDeployHint',
  },
];
