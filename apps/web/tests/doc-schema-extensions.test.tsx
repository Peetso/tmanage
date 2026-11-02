import { generateHTML, generateJSON } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

import { workItemHref } from '@/components/docs/editor/MentionList';
import { docExtensions } from '@/components/docs/editor/schema-extensions';

const ext = docExtensions();
const roundTrip = (html: string) => generateHTML(generateJSON(html, ext), ext);

describe('doc schema extensions', () => {
  it('round-trips callout, comment mark and task item unchanged', () => {
    const once = roundTrip(
      '<div data-type="callout" data-kind="warn"><p>Heads up</p></div>' +
        '<p>Need <mark data-comment="c1">sign-off</mark></p>' +
        '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Brief</p></li></ul>',
    );
    expect(once).toContain('<div data-type="callout" data-kind="warn"><p>Heads up</p></div>');
    expect(once).toContain('<mark data-comment="c1">sign-off</mark>');
    expect(once).toMatch(/<li[^>]*data-checked="true"/);
    expect(roundTrip(once)).toBe(once);
  });

  it('drops data: images and scripts', () => {
    const out = roundTrip(
      '<p>a</p><img src="data:image/png;base64,AAAA"><script>alert(1)</script><p>b</p>',
    );
    expect(out).not.toContain('data:');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert');
  });

  it('keeps a "#" work-item link to the in-app work item (A20)', () => {
    const href = workItemHref('acme', 'w-1');
    expect(href).toBe('/acme/work/w-1');
    const out = roundTrip(`<p>See <a href="${href}">Fix login</a></p>`);
    expect(out).toContain(`href="${href}"`);
    expect(out).toContain('Fix login</a>');
    expect(docExtensions({ workItemSuggestion: {} }).some((e) => e.name === 'workItemLink')).toBe(
      true,
    );
  });
});
