/**
 * 54-01. The connector registry: every third-party app a workspace can connect, defined in code.
 * Changing a definition is a deploy, never a data change; `connector_installations` (0328) only
 * records which of the `managed: 'framework'` connectors an organization installed.
 *
 * The company's Google Drive and OneDrive and each member's Google / Outlook calendar are
 * registered here too (`managed: 'built-in'`): they keep their own tables and sign-in flows
 * (`storage_connections`, `calendar_connections`), and the framework only reads their state.
 *
 * No provider is switched on by this file: an `api-key` connector stores the key the owner pastes
 * in the token vault and makes no outbound call; nothing here holds a client id or a secret.
 */

export type ConnectorAuthType = 'oauth2' | 'api-key';

/** Who holds the connection: the whole workspace, or each member for themselves. */
export type ConnectorScope = 'organization' | 'member';

export type ConnectorCapability = 'files.store' | 'calendar.sync' | 'work.import' | 'links.unfurl';

export interface ConnectorDefinition {
  /** Stable registry key, stored in `connector_installations.connector_key`. */
  readonly key: string;
  /** The product's own name; never translated. */
  readonly name: string;
  readonly authType: ConnectorAuthType;
  /** The provider scopes the connector asks for. */
  readonly scopes: readonly string[];
  readonly capabilities: readonly ConnectorCapability[];
  readonly scope: ConnectorScope;
  /** `built-in`: its own flow and table; `framework`: installed through this registry. */
  readonly managed: 'built-in' | 'framework';
}

export const CONNECTORS: readonly ConnectorDefinition[] = [
  {
    key: 'google_drive',
    name: 'Google Drive',
    authType: 'oauth2',
    scopes: ['https://www.googleapis.com/auth/drive.file'],
    capabilities: ['files.store'],
    scope: 'organization',
    managed: 'built-in',
  },
  {
    key: 'onedrive',
    name: 'OneDrive',
    authType: 'oauth2',
    scopes: ['Files.ReadWrite', 'offline_access'],
    capabilities: ['files.store'],
    scope: 'organization',
    managed: 'built-in',
  },
  {
    key: 'google_calendar',
    name: 'Google Calendar',
    authType: 'oauth2',
    scopes: ['https://www.googleapis.com/auth/calendar.events'],
    capabilities: ['calendar.sync'],
    scope: 'member',
    managed: 'built-in',
  },
  {
    key: 'microsoft_calendar',
    name: 'Outlook Calendar',
    authType: 'oauth2',
    scopes: ['Calendars.ReadWrite', 'offline_access'],
    capabilities: ['calendar.sync'],
    scope: 'member',
    managed: 'built-in',
  },
  {
    key: 'jira',
    name: 'Jira',
    authType: 'api-key',
    scopes: ['read:jira-work'],
    capabilities: ['work.import'],
    scope: 'organization',
    managed: 'framework',
  },
  {
    key: 'github',
    name: 'GitHub',
    authType: 'api-key',
    scopes: ['repo:read'],
    capabilities: ['links.unfurl'],
    scope: 'organization',
    managed: 'framework',
  },
];

export function findConnector(key: string): ConnectorDefinition | undefined {
  return CONNECTORS.find((connector) => connector.key === key);
}
