import { ALTERNATIVE_COPY } from './alternative-copy';
import { findAlternativePage } from './alternative-entries';
import { alternativeTable, type AlternativeTheirs } from './alternative-table';

/**
 * SEOF (B1) — the English text of an alternative page for `llms-full.txt` and its `/md/` twin:
 * the same answer, reasons, table and questions the page shows.
 */

function theirsText(theirs: AlternativeTheirs): string {
  if (theirs.kind === 'pricing') return `[${theirs.text}](${theirs.href})`;
  if (theirs.kind === 'strong') return `${theirs.text} (${theirs.ahead})`;
  return theirs.text;
}

export function alternativeMarkdown(slug: string): string[] {
  const page = findAlternativePage(slug);
  if (page === undefined) return [];
  const copy = ALTERNATIVE_COPY.en;
  const { name } = page.rival;
  const rows = alternativeTable(page, 'en').map(
    (row) => `| ${row.label} | ${row.ours} | ${theirsText(row.theirs)} |`,
  );
  return [
    copy.lede(name),
    `## ${copy.whyTitle(name)}`,
    copy
      .reasons(name, page.fit)
      .map((reason) => `- **${reason.title}.** ${reason.body}`)
      .join('\n'),
    `## ${copy.tableTitle(name)}`,
    [`| ${copy.need} | TManage | ${name} |`, '| --- | --- | --- |', ...rows].join('\n'),
    `${copy.checked(page.rival.checkedOn)}. ${copy.trademark(name)}`,
    `## ${copy.faqTitle(name)}`,
    ...copy
      .faq(name, page.entry.workWord, page.fit)
      .map((item) => `### ${item.question}\n\n${item.answer}`),
  ];
}
