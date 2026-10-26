import type { MessageKey } from './i18n/t';

/**
 * How a work item's activity names a move made through a connected AI app: the real person AND the
 * app, e.g. "Comment written by Peter from Claude via the connector." One sentence per action, so
 * Arabic can order it naturally; an action without its own sentence gets the generic one.
 */
const CONNECTOR_SENTENCES: Readonly<Record<string, MessageKey>> = {
  'work_item.commented': 'WorkItemActivityFeed.aiCommented',
  'work_item.created': 'WorkItemActivityFeed.aiCreated',
  'work_item.transitioned': 'WorkItemActivityFeed.aiTransitioned',
  'work_item.audience_changed': 'WorkItemActivityFeed.aiAudienceChanged',
  'work_item.deleted': 'WorkItemActivityFeed.aiDeleted',
  'work_item.dependency_removed': 'WorkItemActivityFeed.aiDependencyRemoved',
};

/** The sentence for an AI-app move: `{actor}` and `{app}` filled, the app falling back to "an AI assistant". */
export function connectorSentence(
  t: (key: MessageKey) => string,
  action: string,
  actor: string,
  app: string | null,
): string {
  const template = t(CONNECTOR_SENTENCES[action] ?? 'WorkItemActivityFeed.aiChanged');
  const values: Record<string, string> = {
    actor,
    app: app ?? t('WorkItemActivityFeed.aiUnknownApp'),
  };
  return template.replace(/\{(\w+)\}/gu, (whole, slot: string) => values[slot] ?? whole);
}
