import { describe, expect, it } from 'vitest';

import { markdownToHtml } from '@/components/docs/editor/doc-legacy-markdown';

describe('markdownToHtml — a textarea-era body opened in the rich editor', () => {
  it('converts headings', () => {
    expect(markdownToHtml('# Goals')).toBe('<h1 dir="auto">Goals</h1>');
  });
  it('converts a bulleted list', () => {
    expect(markdownToHtml('- a\n- b')).toBe(
      '<ul><li><p dir="auto">a</p></li><li><p dir="auto">b</p></li></ul>',
    );
  });
  it('converts a checklist', () => {
    expect(markdownToHtml('- [x] done')).toBe(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p dir="auto">done</p></li></ul>',
    );
  });
  it('converts a safe link and escapes the rest', () => {
    expect(markdownToHtml('[site](https://a.test) <b> [x](javascript:1)')).toBe(
      '<p dir="auto"><a href="https://a.test" target="_blank" rel="noopener noreferrer">site</a> &lt;b&gt; [x](javascript:1)</p>',
    );
  });
});
