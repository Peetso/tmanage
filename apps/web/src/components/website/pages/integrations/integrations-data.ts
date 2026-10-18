import type { WebIconName } from '../../WebIcon';

/**
 * Integrations page content (SITE-SPEC "PAGE: Integrations"). Every status is "Planned" until
 * engineering confirms a connection is live — the spec's honesty rule, not a placeholder.
 */

export type IntegrationCategory = 'calendar' | 'files' | 'identity' | 'developer' | 'ai' | 'email';

export interface IntegrationFilter {
  id: 'all' | IntegrationCategory;
  label: string;
}

export const INTEGRATION_FILTERS: readonly IntegrationFilter[] = [
  { id: 'all', label: 'All' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'files', label: 'Files & storage' },
  { id: 'identity', label: 'Identity' },
  { id: 'developer', label: 'Developer' },
  { id: 'ai', label: 'AI' },
];

export const CATEGORY_LABEL: Record<IntegrationCategory, string> = {
  calendar: 'Calendar',
  files: 'Files & storage',
  identity: 'Identity',
  developer: 'Developer',
  ai: 'AI',
  email: 'Email',
};

export interface Integration {
  name: string;
  category: IntegrationCategory;
  line: string;
  icon: WebIconName;
  status: 'available' | 'planned';
}

export const INTEGRATIONS: readonly Integration[] = [
  {
    name: 'Google Calendar',
    category: 'calendar',
    line: 'Milestones and meetings land on the calendars your team already checks.',
    icon: 'calendar',
    status: 'planned',
  },
  {
    name: 'Microsoft 365',
    category: 'calendar',
    line: 'Outlook meetings sync both ways, with owners and next steps attached.',
    icon: 'video',
    status: 'planned',
  },
  {
    name: 'Google Drive',
    category: 'files',
    line: 'Link a Drive file to a work item — one source, no copies.',
    icon: 'doc',
    status: 'planned',
  },
  {
    name: 'OneDrive',
    category: 'files',
    line: 'Attach OneDrive and SharePoint files; their sharing rules stay in place.',
    icon: 'globe',
    status: 'planned',
  },
  {
    name: 'Dropbox',
    category: 'files',
    line: 'Point a deliverable at the exact Dropbox file the client will review.',
    icon: 'layers',
    status: 'planned',
  },
  {
    name: 'SAML SSO',
    category: 'identity',
    line: 'Sign in through your company identity provider, with one policy for everyone.',
    icon: 'lock',
    status: 'planned',
  },
  {
    name: 'SCIM',
    category: 'identity',
    line: 'People join and leave automatically when your directory changes.',
    icon: 'id',
    status: 'planned',
  },
  {
    name: 'Webhooks',
    category: 'developer',
    line: 'Send request, approval and milestone events to the systems you run.',
    icon: 'bolt',
    status: 'planned',
  },
  {
    name: 'Deploy hooks',
    category: 'developer',
    line: 'Mark a release delivered the moment your pipeline ships it.',
    icon: 'pulse',
    status: 'planned',
  },
  {
    name: 'REST API',
    category: 'developer',
    line: 'Create requests and update work items from your own scripts.',
    icon: 'link',
    status: 'planned',
  },
  {
    name: 'MCP server',
    category: 'ai',
    line: 'Use your own AI assistant with TManage context — permission-scoped.',
    icon: 'chat',
    status: 'planned',
  },
  {
    name: 'Inbound email',
    category: 'email',
    line: 'Forward a client email into a request.',
    icon: 'mail',
    status: 'planned',
  },
];

/** Quick searches offered under the hero field before anyone types. */
export const SEARCH_HINTS: readonly string[] = ['Calendar', 'SSO', 'Webhook'];

export interface ConnectionStep {
  title: string;
  body: string;
}

export const CONNECTION_STEPS: readonly ConnectionStep[] = [
  {
    title: 'Preview the permissions',
    body: 'Before anything connects, you see each thing it can read and each action it can take — in plain words.',
  },
  {
    title: 'Choose who it acts as',
    body: 'A connection runs as a named person or a service identity, inside the same permissions they already have.',
  },
  {
    title: 'Watch every run in history',
    body: 'Every sync, event and action lands in the history, so you can see what ran, when, and what it changed.',
  },
];
