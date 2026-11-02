import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from './jira-adf.js';
import { jiraDescription } from './jira-issues.js';

const t = (text: string, marks?: unknown[]) => ({
  type: 'text',
  text,
  ...(marks ? { marks } : {}),
});
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const li = (...content: unknown[]) => ({ type: 'listItem', content });

const FIXTURE = {
  type: 'doc',
  version: 1,
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [t('Plan')] },
    p(
      t('Ask '),
      { type: 'mention', attrs: { id: 'x', text: '@Mona' } },
      t(' to see '),
      { type: 'inlineCard', attrs: { url: 'https://acme.atlassian.net/browse/WEB-2' } },
      t(' and '),
      t('click', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
      t(' '),
      t('bold', [{ type: 'strong' }]),
    ),
    {
      type: 'bulletList',
      content: [
        li(p(t('one')), { type: 'bulletList', content: [li(p(t('nested')))] }),
        li(p(t('two'))),
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [p(t('A'))] },
            { type: 'tableHeader', content: [p(t('B'))] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [p(t('1'))] },
            { type: 'tableCell', content: [p(t('x|y'))] },
          ],
        },
      ],
    },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('const a = 1;')] },
  ],
};

describe('adfToMarkdown (R22-e)', () => {
  it('converts headings, mentions, cards, lists, tables and code; a javascript: link is plain', () => {
    const result = adfToMarkdown(FIXTURE);
    expect(result.markdown).toBe(
      [
        '## Plan',
        '',
        'Ask @Mona to see [https://acme.atlassian.net/browse/WEB-2](https://acme.atlassian.net/browse/WEB-2) and click **bold**',
        '',
        '- one\n  - nested\n- two',
        '',
        '| A | B |\n| --- | --- |\n| 1 | x\\|y |',
        '',
        '```ts\nconst a = 1;\n```',
      ].join('\n'),
    );
    expect(result.markdown).not.toContain('javascript');
    expect(result.unknownNodes).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('renders an unknown node as its text and records it once', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'extension', attrs: { text: 'macro body' } },
        { type: 'extension', attrs: { text: 'again' } },
      ],
    };
    const result = adfToMarkdown(doc);
    expect(result.markdown).toBe('macro body\n\nagain');
    expect(result.unknownNodes).toEqual(['extension']);
  });

  it('cuts a 6 000-node document and marks it truncated', () => {
    const doc = {
      type: 'doc',
      content: Array.from({ length: 3000 }, (_, i) => p(t(`n${i}`))),
    };
    const result = adfToMarkdown(doc);
    expect(result.truncated).toBe(true);
    expect(result.markdown.endsWith(' …')).toBe(true);
    expect(result.markdown).not.toContain('n2999');
  });

  it('jiraDescription detects ADF JSON and notes unknown markup', () => {
    const raw = JSON.stringify({
      type: 'doc',
      content: [{ type: 'expand', content: [p(t('x'))] }],
    });
    expect(jiraDescription(raw)).toEqual({ markdown: 'x', notes: ['expand'] });
  });
});
