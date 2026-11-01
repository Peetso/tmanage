import { generateHTML, generateJSON } from '@tiptap/core';
import { describe, expect, it } from 'vitest';

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
});
