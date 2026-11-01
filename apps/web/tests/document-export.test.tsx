import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocumentExportButton } from '../src/components/screens/DocumentExportButton';
import { expectNoAxeViolations } from './axe';

/**
 * DOC export (x131 + R5 frame 10) web control. The API's tenant scoping, the 404-not-403 refusal,
 * the `doc.read` gate and the bytes of each format are proved server-side
 * (`document-export.test.ts`); what only this file can prove is what the *menu* offers and where
 * each entry points.
 */

function openMenu() {
  const view = render(
    <DocumentExportButton
      organizationSlug="acme"
      documentId="document-1"
      apiOrigin="https://api.example.test"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  return view;
}

describe('DocumentExportButton', () => {
  it('lists Markdown, HTML, Word and PDF and stays axe-clean', async () => {
    const { container } = openMenu();
    const labels = screen
      .getAllByRole('menuitem')
      .map((item) => item.querySelector('.tm-doc-export__label')?.textContent);
    expect(labels).toEqual(['Markdown', 'HTML', 'Word', 'PDF']);
    await expectNoAxeViolations(container);
  });

  it('downloads Word from the export.docx route', () => {
    openMenu();
    expect(screen.getByRole('menuitem', { name: /Word/u }).getAttribute('href')).toBe(
      'https://api.example.test/v1/organizations/acme/documents/document-1/export.docx',
    );
  });

  it('opens the print route in a new tab for PDF', () => {
    openMenu();
    const pdf = screen.getByRole('menuitem', { name: /PDF/u });
    expect(pdf.getAttribute('href')).toBe('/acme/docs/document-1/print');
    expect(pdf.getAttribute('target')).toBe('_blank');
  });
});
