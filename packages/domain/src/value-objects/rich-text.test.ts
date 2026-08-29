import { describe, expect, it } from 'vitest';
import {
  InadmissibleRichTextError,
  RICH_TEXT_MAX_DEPTH,
  RICH_TEXT_MAX_NODES,
  RICH_TEXT_MAX_TEXT_LENGTH,
  richTextToPlainText,
  sanitizeRichText,
} from './rich-text.js';
import type { RichTextDocument } from './rich-text.js';

/**
 * The rich-text allowlist — `04-SECURITY-PRIVACY` §6, exercised the way SEC-08 will exercise
 * the screens: with the payloads an attacker actually sends, not only the documents an editor
 * actually produces.
 */

function paragraph(text: string): unknown {
  return { type: 'paragraph', content: [{ type: 'text', text }] };
}

function doc(...blocks: unknown[]): unknown {
  return { type: 'doc', content: blocks };
}

function refusal(input: unknown): InadmissibleRichTextError {
  try {
    sanitizeRichText(input);
  } catch (error) {
    if (error instanceof InadmissibleRichTextError) return error;
    throw error;
  }
  throw new Error('expected the document to be refused');
}

describe('sanitizeRichText — admissible documents', () => {
  it('admits a paragraph of plain text', () => {
    const result = sanitizeRichText(doc(paragraph('Hello there')));
    expect(result).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello there' }] }],
    });
  });

  it('admits every mark in the allowlist', () => {
    const result = sanitizeRichText(
      doc({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'b', marks: [{ type: 'italic' }, { type: 'strike' }] },
          { type: 'text', text: 'c', marks: [{ type: 'code' }] },
          { type: 'text', text: 'd', marks: [{ type: 'link', href: 'https://example.com/x' }] },
        ],
      }),
    );
    expect(result.content).toHaveLength(1);
  });

  it('admits mailto and http links', () => {
    for (const href of ['mailto:amira@example.com', 'http://example.com/']) {
      expect(() =>
        sanitizeRichText(
          doc({
            type: 'paragraph',
            content: [{ type: 'text', text: 'x', marks: [{ type: 'link', href }] }],
          }),
        ),
      ).not.toThrow();
    }
  });

  it('admits a code block whose text holds newlines', () => {
    const result = sanitizeRichText(
      doc({ type: 'code_block', content: [{ type: 'text', text: 'line one\nline two' }] }),
    );
    expect(richTextToPlainText(result)).toBe('line one\nline two');
  });

  it('admits hard breaks, quotes and both list kinds', () => {
    const result = sanitizeRichText(
      doc(
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'first' },
            { type: 'hard_break' },
            { type: 'text', text: 'second' },
          ],
        },
        { type: 'blockquote', content: [paragraph('quoted')] },
        { type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph('point')] }] },
        { type: 'ordered_list', content: [{ type: 'list_item', content: [paragraph('step')] }] },
      ),
    );
    expect(richTextToPlainText(result)).toBe('first\nsecond\nquoted\n- point\n1. step');
  });

  it('admits an empty paragraph as a blank line when the document has text elsewhere', () => {
    expect(() =>
      sanitizeRichText(doc(paragraph('above'), { type: 'paragraph', content: [] })),
    ).not.toThrow();
  });

  it('rebuilds the document rather than blessing the input', () => {
    const input = doc(paragraph('clean'));
    const result = sanitizeRichText(input);
    expect(result).not.toBe(input);
    expect(Object.keys(result)).toEqual(['type', 'content']);
    expect(Object.keys(result.content[0] as object)).toEqual(['type', 'content']);
  });
});

describe('sanitizeRichText — the allowlist refuses', () => {
  it('an unknown block type, naming the path', () => {
    const error = refusal(doc({ type: 'heading', content: [] }));
    expect(error.path).toBe('doc.content[0]');
    expect(error.message).toContain('unknown block "heading"');
  });

  it('an unknown inline node', () => {
    const error = refusal(doc({ type: 'paragraph', content: [{ type: 'image', src: 'x' }] }));
    expect(error.message).toContain('unknown inline node "image"');
  });

  it('an unknown mark', () => {
    const error = refusal(
      doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'font', face: 'Comic Sans' }] }],
      }),
    );
    expect(error.message).toContain('unknown mark "font"');
  });

  it('an unknown key on a known node', () => {
    const error = refusal(
      doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', onclick: 'alert(1)' }] }),
    );
    expect(error.message).toContain('unknown key "onclick"');
  });

  it('a javascript: link, however it is spelled', () => {
    for (const href of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'javascript\t:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
    ]) {
      const error = refusal(
        doc({
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', href }] }],
        }),
      );
      expect(error.path).toContain('.href');
    }
  });

  it('a relative link — the scheme must be visible to be judged', () => {
    const error = refusal(
      doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'link', href: '/etc/passwd' }] }],
      }),
    );
    expect(error.message).toContain('absolute URL');
  });

  it('a duplicate mark', () => {
    const error = refusal(
      doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'bold' }] }],
      }),
    );
    expect(error.message).toContain('duplicate mark "bold"');
  });

  it('marks inside a code block — code is verbatim', () => {
    const error = refusal(
      doc({
        type: 'code_block',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }],
      }),
    );
    expect(error.message).toContain('unknown key "marks"');
  });

  it('a literal newline inside a paragraph text node', () => {
    const error = refusal(doc(paragraph('line one\nline two')));
    expect(error.message).toContain('hard_break');
  });

  it('control characters anywhere', () => {
    expect(refusal(doc(paragraph('null\u0000byte'))).message).toContain('control characters');
    expect(refusal(doc(paragraph('cr\rlf'))).message).toContain('control characters');
    expect(
      refusal(doc({ type: 'code_block', content: [{ type: 'text', text: 'esc\u001b[0m' }] }))
        .message,
    ).toContain('control characters');
  });

  it('an empty text node', () => {
    expect(
      refusal(doc({ type: 'paragraph', content: [{ type: 'text', text: '' }] })).message,
    ).toContain('must not be empty');
  });

  it('a document with no blocks, and a document with no text', () => {
    expect(refusal({ type: 'doc', content: [] }).path).toBe('doc.content');
    expect(refusal(doc({ type: 'paragraph', content: [] })).message).toContain('no text');
    expect(refusal(doc(paragraph('   '))).message).toContain('no text');
  });

  it('a root that is not a doc, or not an object at all', () => {
    expect(refusal('<b>hi</b>').message).toContain('must be an object');
    expect(refusal(null).message).toContain('must be an object');
    expect(refusal([paragraph('x')]).message).toContain('must be an object');
    expect(refusal({ type: 'paragraph', content: [] }).message).toContain('type "doc"');
  });

  it('a list holding something other than list items', () => {
    const error = refusal(doc({ type: 'bullet_list', content: [paragraph('loose')] }));
    expect(error.message).toContain('list_item');
  });

  it('an empty blockquote, list and list item', () => {
    expect(refusal(doc({ type: 'blockquote', content: [] })).message).toContain('not be empty');
    expect(refusal(doc({ type: 'bullet_list', content: [] })).message).toContain('not be empty');
    expect(
      refusal(doc({ type: 'bullet_list', content: [{ type: 'list_item', content: [] }] })).message,
    ).toContain('not be empty');
  });
});

describe('sanitizeRichText — complexity limits', () => {
  it(`refuses nesting past ${RICH_TEXT_MAX_DEPTH} levels`, () => {
    let block: unknown = paragraph('deep');
    for (let i = 0; i < RICH_TEXT_MAX_DEPTH + 1; i += 1) {
      block = { type: 'blockquote', content: [block] };
    }
    expect(refusal(doc(block)).message).toContain('nest at most');
  });

  it(`admits nesting at exactly ${RICH_TEXT_MAX_DEPTH} levels`, () => {
    let block: unknown = paragraph('deep');
    for (let i = 0; i < RICH_TEXT_MAX_DEPTH - 1; i += 1) {
      block = { type: 'blockquote', content: [block] };
    }
    expect(() => sanitizeRichText(doc(block))).not.toThrow();
  });

  it(`refuses more than ${RICH_TEXT_MAX_NODES} nodes`, () => {
    const blocks = Array.from({ length: RICH_TEXT_MAX_NODES + 1 }, () => paragraph('x'));
    expect(refusal(doc(...blocks)).message).toContain('nodes');
  });

  it(`refuses more than ${RICH_TEXT_MAX_TEXT_LENGTH} characters of text in total`, () => {
    const half = 'a'.repeat(9_000);
    expect(refusal(doc(paragraph(half), paragraph(half))).message).toContain('characters of text');
  });

  it(`admits a document at exactly the text ceiling`, () => {
    expect(() =>
      sanitizeRichText(doc(paragraph('a'.repeat(RICH_TEXT_MAX_TEXT_LENGTH)))),
    ).not.toThrow();
  });
});

describe('richTextToPlainText', () => {
  it('derives the text a search would index', () => {
    const document: RichTextDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The ', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'plan', marks: [{ type: 'link', href: 'https://example.com' }] },
          ],
        },
        { type: 'code_block', content: [{ type: 'text', text: 'const x = 1;' }] },
      ],
    };
    expect(richTextToPlainText(document)).toBe('The plan\nconst x = 1;');
  });

  it('marks list items so a plain reading keeps the structure', () => {
    const document = sanitizeRichText(
      doc({
        type: 'ordered_list',
        content: [
          { type: 'list_item', content: [paragraph('first')] },
          { type: 'list_item', content: [paragraph('second')] },
        ],
      }),
    );
    expect(richTextToPlainText(document)).toBe('1. first\n2. second');
  });
});
