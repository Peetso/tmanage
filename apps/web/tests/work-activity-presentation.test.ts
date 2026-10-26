import { expect, it } from 'vitest';
import { translate, type MessageKey } from '../src/lib/i18n/t';
import { connectorSentence } from '../src/lib/work-activity-presentation';

it('names the person and the AI app for a connector move, with a fallback app', () => {
  const en = (key: MessageKey) => translate('en', key);
  expect(connectorSentence(en, 'work_item.commented', 'Peter', 'Claude')).toBe(
    'Comment written by Peter from Claude via the connector.',
  );
  expect(connectorSentence(en, 'x.y', 'Peter', null)).toContain('from an AI assistant via');
});
