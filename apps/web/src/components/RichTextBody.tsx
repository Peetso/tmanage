import type { ReactNode } from 'react';
import type {
  RichTextBlock,
  RichTextDocument,
  RichTextInline,
  RichTextText,
} from '@tmanage/domain';

/**
 * Render a sanitised rich-text document — CHAT-002's closed grammar, drawn.
 *
 * This renderer trusts the *shape* it is given and nothing else. The document arrived from
 * the API, which stores nothing `sanitizeRichText` did not admit, so every node here is one
 * of the grammar's eight types and every link href is `http`, `https` or `mailto`. There is
 * no `dangerouslySetInnerHTML` anywhere in this file and must never be: text reaches the DOM
 * only as React text nodes, which is what makes a message that *says*
 * `<script>` render as those nine characters.
 *
 * Links still get `rel="noopener noreferrer"` and open in a new tab. The scheme allowlist
 * made the destination safe to follow; it did not make the destination page part of this
 * application, and a channel message is exactly where a link to elsewhere appears.
 *
 * An unknown node type renders nothing rather than throwing. The grammar is closed, so this
 * arm is unreachable today — but a renderer that crashed the whole transcript over one node
 * a future migration added would turn a forward-compatibility gap into an outage.
 */
export function RichTextBody({ document }: { document: RichTextDocument }) {
  return <div className="tm-prose">{document.content.map(renderBlock)}</div>;
}

function renderBlock(block: RichTextBlock, index: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <p key={index}>{block.content.map(renderInline)}</p>;
    case 'code_block':
      return (
        <pre key={index}>
          <code>{block.content.map((node) => node.text).join('')}</code>
        </pre>
      );
    case 'blockquote':
      return <blockquote key={index}>{block.content.map(renderBlock)}</blockquote>;
    case 'bullet_list':
      return (
        <ul key={index}>
          {block.content.map((item, itemIndex) => (
            <li key={itemIndex}>{item.content.map(renderBlock)}</li>
          ))}
        </ul>
      );
    case 'ordered_list':
      return (
        <ol key={index}>
          {block.content.map((item, itemIndex) => (
            <li key={itemIndex}>{item.content.map(renderBlock)}</li>
          ))}
        </ol>
      );
    default:
      return null;
  }
}

function renderInline(node: RichTextInline, index: number): ReactNode {
  if (node.type === 'hard_break') return <br key={index} />;
  return <span key={index}>{renderMarks(node)}</span>;
}

/**
 * Marks nest inside out: `bold` + `link` becomes `<a><strong>text</strong></a>`. The order
 * marks arrive in is the order the sanitiser admitted, and duplicates were refused there, so
 * a simple fold is enough.
 */
function renderMarks(node: RichTextText): ReactNode {
  let rendered: ReactNode = node.text;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        rendered = <strong>{rendered}</strong>;
        break;
      case 'italic':
        rendered = <em>{rendered}</em>;
        break;
      case 'strike':
        rendered = <s>{rendered}</s>;
        break;
      case 'code':
        rendered = <code>{rendered}</code>;
        break;
      case 'link':
        rendered = (
          <a href={mark.href} target="_blank" rel="noopener noreferrer">
            {rendered}
          </a>
        );
        break;
    }
  }
  return rendered;
}
