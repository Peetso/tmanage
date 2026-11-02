import { describe, expect, it } from 'vitest';
import { renderSlack, renderTeams } from './channel-messages.js';

const event = {
  kind: 'work.completed',
  title: 'Logo <@here>',
  state: 'done',
  link: 'https://t.example/acme/work/1',
};

describe('channel notices (R15-c)', () => {
  it('wraps every Arabic Slack line in U+200F and escapes mrkdwn', () => {
    const ar = renderSlack(event, 'ar');
    for (const block of ar.blocks)
      expect((block['text'] as { text: string }).text).toMatch(/^\u200F.*\u200F$/u);
    expect(JSON.stringify(renderSlack(event, 'en'))).toContain('Logo &lt;@here&gt;');
  });

  it('renders a Teams Adaptive Card 1.4 with rtl only for Arabic', () => {
    const card = (m: Record<string, unknown>) =>
      (m['attachments'] as { content: Record<string, unknown> }[])[0]?.content;
    expect(card(renderTeams(event, 'ar'))).toMatchObject({ version: '1.4', rtl: true });
    expect(card(renderTeams(event, 'en'))?.['rtl']).toBeUndefined();
  });
});
