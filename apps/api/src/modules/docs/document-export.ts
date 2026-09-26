/**
 * DOC export (x131) — the pure Markdown serializer for a document.
 *
 * The bytes half of the export, kept apart from the controller for the reason
 * {@link ../audit/audit-export-csv.ts} keeps the CSV serializer apart from its controller: the
 * capability gate, the tenant scope and the tenant-scoped-before-relation resolution all live in
 * {@link DocumentsService.get} (reused by {@link DocumentExportController}); this file only turns a
 * document's title and current-version body into a Markdown document, and so can be unit-tested with
 * no database, principal or HTTP in sight.
 *
 * ## The current-version body, front-matter titled
 *
 * A document's `body` column is kept equal to its newest version's body (DOC-02 saves both in one
 * transaction), so the current-version Markdown is exactly `body` under a YAML front-matter block
 * carrying the title. That is the whole surface a reader ever sees — no `organizationId`, no author
 * id, no version metadata — because a wider projection is a product decision (`12-PERMISSION-MATRIX`
 * / doc 38 "collaboration later"), not this export's to make.
 *
 * ## The title can never break out of the front-matter
 *
 * `documents.title` is free VARCHAR(300) text a member typed. Emitted raw into a YAML block it could
 * carry a newline that opens a second key, or a quote that unbalances the scalar. The title is
 * therefore emitted as a YAML double-quoted scalar: any CR/LF is folded to a single space (a title
 * is one line by construction) and a backslash or double-quote is backslash-escaped, the two
 * characters a double-quoted YAML scalar treats specially. The body is content, not structure, so it
 * is emitted verbatim after the closing fence.
 */

/** The narrow input the renderer needs — a document's title and current-version body. */
export interface ExportableDocument {
  readonly title: string;
  readonly body: string;
}

/** The YAML front-matter fence. */
const FENCE = '---';

/**
 * Make a title safe as a YAML double-quoted scalar: fold line breaks to a space, then
 * backslash-escape the backslash and the double-quote. The backslash is escaped first so an escape
 * introduced for a quote is not itself re-escaped.
 */
function escapeYamlDoubleQuoted(title: string): string {
  return title.replace(/\r?\n|\r/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Serialize a document to a Markdown document: a YAML front-matter block naming the title, then the
 * current-version body verbatim. The result ends in a single trailing newline.
 */
export function renderDocumentMarkdown(document: ExportableDocument): string {
  const frontMatter = `${FENCE}\ntitle: "${escapeYamlDoubleQuoted(document.title)}"\n${FENCE}\n`;
  const body = document.body.endsWith('\n') ? document.body : `${document.body}\n`;
  return `${frontMatter}\n${body}`;
}
