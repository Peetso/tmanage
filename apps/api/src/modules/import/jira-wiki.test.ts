import { describe, expect, it } from 'vitest';
import { wikiToMarkdown } from './jira-wiki.js';

const ARABIC = 'هذه فقرة عربية مع رقم ١٢٣ و-نص (مثال).';

describe('wikiToMarkdown (R22-e)', () => {
  it('converts code, tables, images, links and inline marks; Arabic stays byte-identical', () => {
    const input = [
      'h2. Setup',
      '*bold* and -gone- and +under+ and {{mono}}',
      'See [the docs|http://x] or [bad|javascript:alert(1)]',
      '{code:js}',
      'const a = *b*;',
      '{code}',
      '||Name||Value||',
      '|a|!img.png!|',
      '* one',
      '** nested',
      '# first',
      ARABIC,
    ].join('\n');
    const result = wikiToMarkdown(input);
    expect(result.markdown).toBe(
      [
        '## Setup',
        '**bold** and ~~gone~~ and __under__ and `mono`',
        'See [the docs](http://x) or bad',
        '',
        '```js',
        'const a = *b*;',
        '```',
        '',
        '| Name | Value |',
        '| --- | --- |',
        '| a | [attachment: img.png] |',
        '- one',
        '  - nested',
        '1. first',
        ARABIC,
      ].join('\n'),
    );
    expect(Buffer.from(result.markdown.split('\n').at(-1) ?? '')).toEqual(Buffer.from(ARABIC));
    expect(result.unknownMacros).toEqual([]);
  });

  it('keeps an unknown macro body, unwraps color, and names the macro', () => {
    const result = wikiToMarkdown('{status}Done{status} {color:red}red{color}\n{quote}hi{quote}');
    expect(result.markdown).toBe('Done red\n\n> hi');
    expect(result.unknownMacros).toEqual(['status']);
  });
});
