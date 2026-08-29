import { describe, expect, it } from 'vitest';
import { sanitizeRichText } from '@tmanage/domain';
import { composeMessage } from '../src/lib/rich-composer';

/**
 * The notation-to-grammar conversion, enumerated. The property that matters most is the
 * last describe: everything this module can emit is admissible to the domain's own
 * sanitiser, because a composer that could build a document the API refuses would hand
 * the author an error about a tree they never saw.
 */

function richOrFail(text: string) {
  const composed = composeMessage(text);
  expect(composed.kind).toBe('rich');
  if (composed.kind !== 'rich') throw new Error('unreachable');
  return composed.document;
}

describe('plain drafts stay plain', () => {
  it('sends unformatted text as plain, line breaks and all', () => {
    const composed = composeMessage('First line.\nSecond line.\n\nNew paragraph.');
    expect(composed).toEqual({
      kind: 'plain',
      body: 'First line.\nSecond line.\n\nNew paragraph.',
    });
  });

  it('leaves unmatched notation literal, and therefore plain', () => {
    // A lone ** and a snake_case identifier are not formatting.
    const composed = composeMessage('the ** operator and a snake_case_name');
    expect(composed.kind).toBe('plain');
  });

  it('treats a link with a refused scheme as literal text', () => {
    // javascript: is exactly what the grammar's scheme allowlist exists to refuse; the
    // composer never builds the mark, so nothing reaches the sanitiser to be refused.
    const composed = composeMessage('[click](javascript:alert(1))');
    expect(composed.kind).toBe('plain');
  });
});

describe('inline notation', () => {
  it('converts bold, italic, strike, code and links to marks', () => {
    const document = richOrFail('**bold** _italic_ ~~gone~~ `code` [docs](https://example.com)');
    expect(document.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'gone', marks: [{ type: 'strike' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'docs', marks: [{ type: 'link', href: 'https://example.com' }] },
      ],
    });
  });

  it('keeps notation inside a code span literal', () => {
    const document = richOrFail('`**not bold**`');
    expect(document.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '**not bold**', marks: [{ type: 'code' }] }],
    });
  });

  it('turns a single newline into a hard break, not a character', () => {
    const document = richOrFail('**Title**\nsecond line');
    const paragraph = document.content[0];
    expect(paragraph).toMatchObject({ type: 'paragraph' });
    if (paragraph?.type === 'paragraph') {
      expect(paragraph.content[1]).toEqual({ type: 'hard_break' });
    }
  });
});

describe('block notation', () => {
  it('converts list, quote and fence prefixes to their blocks', () => {
    const document = richOrFail(
      ['- first', '- second', '', '> quoted words', '', '```', 'const x = 1;', '```'].join('\n'),
    );
    expect(document.content.map((block) => block.type)).toEqual([
      'bullet_list',
      'blockquote',
      'code_block',
    ]);
    expect(document.content[0]).toEqual({
      type: 'bullet_list',
      content: [
        {
          type: 'list_item',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
        },
        {
          type: 'list_item',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
        },
      ],
    });
    expect(document.content[2]).toEqual({
      type: 'code_block',
      content: [{ type: 'text', text: 'const x = 1;' }],
    });
  });

  it('numbers make an ordered list; a year followed by a period does not', () => {
    const ordered = richOrFail('1. first\n2. second');
    expect(ordered.content[0]?.type).toBe('ordered_list');

    expect(composeMessage('2026. was the year it shipped').kind).toBe('plain');
  });

  it('keeps a code block verbatim — newlines stay characters, notation stays text', () => {
    const document = richOrFail('```\n**verbatim**\nline two\n```');
    expect(document.content[0]).toEqual({
      type: 'code_block',
      content: [{ type: 'text', text: '**verbatim**\nline two' }],
    });
  });
});

describe('everything emitted is admissible', () => {
  const drafts = [
    '**bold** and _italic_ and `code`',
    '- a list\n- with **marks**\n\n> and a quote\n\n```\ncode\n```',
    '[a link](https://example.com/path) beside ~~struck~~ text',
    '1. one\n2. two\n3. three',
    'paragraph one\ncontinued\n\n**paragraph two**',
  ];

  for (const draft of drafts) {
    it(`sanitizeRichText admits: ${JSON.stringify(draft.slice(0, 40))}`, () => {
      const composed = composeMessage(draft);
      if (composed.kind === 'rich') {
        // Throws on anything inadmissible; the assertion is that it does not.
        expect(sanitizeRichText(composed.document)).toBeTruthy();
      }
    });
  }
});
