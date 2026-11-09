import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfficeDocxStage, neutralizeDocument } from '../src/components/viewer/OfficeDocxStage';
import { OfficePptxStage } from '../src/components/viewer/OfficePptxStage';
import { OfficeXlsxStage } from '../src/components/viewer/OfficeXlsxStage';
import { PsdLayersPanel, PsdNotice } from '../src/components/viewer/PsdLayersPanel';
import { EmbeddedPreviewChip, UnsupportedStage } from '../src/components/viewer/UnsupportedStage';
import { ZipList, zipTree } from '../src/components/viewer/ZipList';
import { formatSize } from '../src/components/viewer/format-stage-helpers';
import type { PreviewPsd, PreviewZip } from '../src/lib/api/file-preview';
import type { ReviewThread } from '../src/lib/api/review';
import { activeLocale } from '../src/lib/i18n/locale-store';
import { readDeck } from '../src/lib/office/pptx-read';
import {
  columnName,
  formatNumber,
  parseCellAddress,
  readWorkbook,
} from '../src/lib/office/xlsx-read';
import { expectNoAxeViolations } from './axe';

/**
 * R4 slice 10 — PSD layers, ZIP list, Office stages (Excel grid with cell comments, PowerPoint
 * slides with the slide box pins sit in, Word pages) and the "no preview" stage (Figma batch C
 * V-22, V-24, V-25, V-26). Office packages are built in the test with JSZip.
 */

vi.mock('docx-preview', () => ({
  renderAsync: async (_data: unknown, body: HTMLElement) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'tm-docx-wrapper';
    for (const text of ['Page one', 'Page two']) {
      const section = document.createElement('section');
      section.className = 'tm-docx';
      const p = document.createElement('p');
      p.textContent = text;
      const link = document.createElement('a');
      link.setAttribute('href', 'javascript:alert(1)');
      link.setAttribute('onclick', 'alert(1)');
      link.textContent = 'link';
      section.append(p, link);
      wrapper.append(section);
    }
    body.append(wrapper);
  },
}));

// jsdom's Blob is not the one Node's URL.createObjectURL takes; the stages only need a URL back.
let objectUrls = 0;
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test/${(objectUrls += 1)}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => activeLocale.set('en-GB'));
});

function thread(overrides: Partial<ReviewThread> & { id: string; number: number }): ReviewThread {
  return {
    subjectType: 'file_asset',
    subjectId: 'f1',
    fileVersionId: 'v1',
    anchorKind: 'pin',
    anchor: null,
    pageNo: null,
    timeMs: null,
    audience: 'internal',
    status: 'open',
    createdBy: { membershipId: 'm1', displayName: 'Maya Hassan', kind: 'internal' },
    createdAt: '2026-11-01T10:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    carriedFromThreadId: null,
    comments: [],
    canResolve: true,
    canMove: false,
    ...overrides,
  };
}

async function packageBytes(files: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, body] of Object.entries(files)) zip.file(path, body);
  return zip.generateAsync({ type: 'arraybuffer' });
}

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

function workbookFiles(): Record<string, string> {
  return {
    'xl/workbook.xml': `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets><sheet name="Rates" sheetId="1" r:id="rId1"/><sheet name="Seasons" sheetId="2" r:id="rId2"/><sheet name="Old" sheetId="3" state="hidden" r:id="rId3"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="ws" Target="worksheets/sheet3.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<sst xmlns="${NS_MAIN}"><si><t>Room type</t></si><si><t>Nile Suite</t></si><si><r><t>Deluxe </t></r><r><t>King</t></r></si></sst>`,
    'xl/styles.xml': `<styleSheet xmlns="${NS_MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="3"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${NS_MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Jan</t></is></c></row><row r="7"><c r="A7" t="s"><v>1</v></c><c r="C7" s="1"><v>2450</v></c><c r="D7" s="2"><v>0.125</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="b"><v>1</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${NS_MAIN}"><sheetData><row r="1"><c r="A1" t="str"><v>High</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet3.xml': `<worksheet xmlns="${NS_MAIN}"><sheetData/></worksheet>`,
  };
}

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function deckFiles(): Record<string, string> {
  const slide = (title: string) =>
    `<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}" xmlns:r="${NS_REL}"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F5F5F0"/></a:solidFill></p:bgPr></p:bg><p:spTree>` +
    `<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>` +
    `<p:sp><p:spPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="3048000" cy="1714500"/></a:xfrm><a:solidFill><a:srgbClr val="D9F99D"/></a:solidFill></p:spPr></p:sp>` +
    `<p:pic><p:blipFill><a:blip r:embed="rId9"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="685800"/></a:xfrm></p:spPr></p:pic>` +
    `</p:spTree></p:cSld></p:sld>`;
  return {
    'ppt/presentation.xml': `<p:presentation xmlns:p="${NS_P}" xmlns:r="${NS_REL}"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId2" Type="s" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="s" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': slide('Q1 launch plan'),
    'ppt/slides/slide2.xml': slide('Rooms'),
    'ppt/slides/_rels/slide1.xml.rels': `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="l" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId9" Type="i" Target="../media/image1.png"/></Relationships>`,
    'ppt/slides/_rels/slide2.xml.rels': `<Relationships xmlns="${NS_PKG}"><Relationship Id="rId1" Type="l" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
    'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="609600" y="457200"/><a:ext cx="10972800" cy="1143000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`,
    'ppt/theme/theme1.xml': `<a:theme xmlns:a="${NS_A}"><a:themeElements><a:clrScheme name="T"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1></a:clrScheme></a:themeElements></a:theme>`,
    'ppt/media/image1.png': 'not really a png',
  };
}

describe('Excel reader', () => {
  it('names columns and parses addresses', () => {
    expect([0, 25, 26, 51, 701].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'ZZ']);
    expect(parseCellAddress('C7')).toEqual({ column: 2, row: 6 });
    expect(parseCellAddress('c7')).toBeNull();
    expect(formatNumber(2650, '#,##0', 'en-GB')).toBe('2,650');
    expect(formatNumber(0.125, '0.0%', 'en-GB')).toBe('12.5%');
    expect(formatNumber(1.5, 'General', 'en-GB')).toBe('1.5');
  });

  it('reads shared, inline and rich strings, booleans and formatted numbers per sheet', async () => {
    const workbook = await readWorkbook(await packageBytes(workbookFiles()));
    expect(workbook.sheets.map((sheet) => [sheet.name, sheet.hidden])).toEqual([
      ['Rates', false],
      ['Seasons', false],
      ['Old', true],
    ]);
    const rates = workbook.sheets[0]!;
    expect(rates.cells.get('A1')).toEqual({ text: 'Room type', numeric: false });
    expect(rates.cells.get('C1')?.text).toBe('Jan');
    expect(rates.cells.get('A2')?.text).toBe('Deluxe King');
    expect(rates.cells.get('B2')?.text).toBe('TRUE');
    expect(rates.cells.get('C7')).toEqual({ text: '2,450', numeric: true });
    expect(rates.cells.get('D7')?.text).toBe('12.5%');
    expect([rates.rowCount, rates.columnCount]).toEqual([7, 4]);
  });
});

describe('OfficeXlsxStage (V-25 Excel)', () => {
  const bytes = () => packageBytes(workbookFiles());

  it('draws the grid, numbers cell comments, and comments on a clicked cell', async () => {
    const onCommentCell = vi.fn();
    const onSelectThread = vi.fn();
    const data = await bytes();
    const { container } = render(
      <OfficeXlsxStage
        src="https://api.example.test/f1/content"
        office={null}
        threads={[
          thread({
            id: 't1',
            number: 1,
            anchorKind: 'cell',
            anchor: { sheet: 'Rates', cell: 'C7' },
          }),
          thread({
            id: 't2',
            number: 2,
            anchorKind: 'cell',
            anchor: { sheet: 'Seasons', cell: 'A1' },
          }),
        ]}
        selectedThreadId={null}
        onSelectThread={onSelectThread}
        onCommentCell={onCommentCell}
        fetcher={async () => data}
      />,
    );
    expect(await screen.findByRole('grid', { name: 'Sheet Rates' })).toBeTruthy();
    expect(
      screen.getByText('Layout is approximate — download the original for the exact file.'),
    ).toBeTruthy();
    // Hidden sheets get no tab; each tab counts its open comments.
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Rates1', 'Seasons1']);
    const marker = screen.getByRole('button', { name: 'Comment 1 on Rates!C7' });
    fireEvent.click(marker);
    expect(onSelectThread).toHaveBeenCalledWith('t1');
    fireEvent.click(container.querySelector('[data-cell="B3"]')!);
    expect(onCommentCell).toHaveBeenCalledWith({ sheet: 'Rates', cell: 'B3' });
    // Keyboard: arrows move, Enter comments.
    const grid = screen.getByRole('grid');
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(onCommentCell).toHaveBeenLastCalledWith({ sheet: 'Rates', cell: 'B4' });
    await expectNoAxeViolations(container);
  });

  it('opens the sheet of a thread chosen in the rail and highlights its cell', async () => {
    const data = await bytes();
    const { container } = render(
      <OfficeXlsxStage
        src="https://api.example.test/f1/content"
        office={null}
        threads={[
          thread({
            id: 't2',
            number: 2,
            anchorKind: 'cell',
            anchor: { sheet: 'Seasons', cell: 'A1' },
          }),
        ]}
        selectedThreadId="t2"
        onSelectThread={() => undefined}
        fetcher={async () => data}
      />,
    );
    expect(await screen.findByRole('grid', { name: 'Sheet Seasons' })).toBeTruthy();
    expect(container.querySelector('[data-cell="A1"]')?.getAttribute('data-selected')).toBe('true');
    expect(screen.getAllByText('High').length).toBeGreaterThan(0);
    // Read-only: no comment hint.
    expect(screen.getByText(/Comments stay on their cell address/)).toBeTruthy();
  });

  it('offers the download when the file cannot be drawn', async () => {
    const onDownload = vi.fn();
    render(
      <OfficeXlsxStage
        src="https://api.example.test/f1/content"
        office={null}
        threads={[]}
        selectedThreadId={null}
        onSelectThread={() => undefined}
        onDownload={onDownload}
        fetcher={async () => new TextEncoder().encode('not a zip').buffer}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Download to view' }));
    expect(onDownload).toHaveBeenCalled();
  });

  it('keeps the sheet left to right in Arabic', async () => {
    act(() => activeLocale.set('ar-EG'));
    const data = await bytes();
    render(
      <OfficeXlsxStage
        src="https://api.example.test/f1/content"
        office={null}
        threads={[]}
        selectedThreadId={null}
        onSelectThread={() => undefined}
        fetcher={async () => data}
      />,
    );
    const grid = await screen.findByRole('grid');
    expect(grid.closest('[dir]')?.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('التنسيق تقريبي — نزّل الملف الأصلي لترى شكله الدقيق.')).toBeTruthy();
  });
});

describe('PowerPoint reader and stage (V-25 PowerPoint)', () => {
  it('reads slides in order with the layout position of a placeholder and theme colours', async () => {
    const deck = await readDeck(await packageBytes(deckFiles()));
    expect([deck.width, deck.height, deck.slides.length]).toEqual([12_192_000, 6_858_000, 2]);
    const [title, box, picture] = deck.slides[0]!.shapes;
    expect(title).toMatchObject({ kind: 'text', x: 0.05, y: expect.closeTo(0.0667, 3) });
    expect(title?.paragraphs[0]).toMatchObject({
      align: 'center',
      runs: [{ text: 'Q1 launch plan', sizePt: 44, bold: true, color: '#111111' }],
    });
    expect(box).toMatchObject({ kind: 'text', x: 0.5, y: 0.5, w: 0.25, h: 0.25, fill: '#D9F99D' });
    expect(picture).toMatchObject({ kind: 'picture', media: 'ppt/media/image1.png' });
    expect(deck.slides[0]!.background).toBe('#F5F5F0');
    expect(deck.media.get('ppt/media/image1.png')).toMatch(/^blob:/);
  });

  it('keeps a shape fill’s alpha, so a 10 % tint does not hide text of the same colour (FIX5)', async () => {
    const files = deckFiles();
    files['ppt/slides/slide2.xml'] =
      `<p:sld xmlns:p="${NS_P}" xmlns:a="${NS_A}"><p:cSld><p:spTree>` +
      `<p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="3048000" cy="342900"/></a:xfrm><a:solidFill><a:srgbClr val="FFC21A"><a:alpha val="10000"/></a:srgbClr></a:solidFill></p:spPr>` +
      `<p:txBody><a:p><a:r><a:rPr><a:solidFill><a:srgbClr val="FFC21A"/></a:solidFill></a:rPr><a:t>01 · WHY VARIABLES FIRST</a:t></a:r></a:p></p:txBody></p:sp>` +
      `</p:spTree></p:cSld></p:sld>`;
    const deck = await readDeck(await packageBytes(files));
    const [chip] = deck.slides[1]!.shapes;
    expect(chip).toMatchObject({ kind: 'text', fill: 'rgba(255, 194, 26, 0.1)' });
    expect(chip?.kind === 'text' && chip.paragraphs[0]?.runs[0]?.color).toBe('#FFC21A');
  });

  it('shows one slide with its pins, the counter, and a strip with open counts', async () => {
    const data = await packageBytes(deckFiles());
    const onSlideChange = vi.fn();
    const { container } = render(
      <OfficePptxStage
        src="https://api.example.test/f1/content"
        office={{
          format: 'pptx',
          pages: 2,
          pageWidth: 12_192_000,
          pageHeight: 6_858_000,
          sheets: [],
        }}
        threads={[thread({ id: 't1', number: 1, pageNo: 2 })]}
        selectedThreadId={null}
        onSlideChange={onSlideChange}
        renderSlideOverlay={(slide) => <span data-testid="overlay">{`pins of ${slide}`}</span>}
        fetcher={async () => data}
      />,
    );
    expect(await screen.findByText('Slide 1 of 2')).toBeTruthy();
    expect(screen.getByTestId('overlay').textContent).toBe('pins of 1');
    const strip = screen.getByRole('navigation', { name: 'Slides' });
    fireEvent.click(within(strip).getByRole('button', { name: 'Slide 2, 1 open' }));
    expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
    expect(onSlideChange).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId('overlay').textContent).toBe('pins of 2');
    // The slide is the file: it never mirrors.
    expect(container.querySelector('.tm-slide')?.getAttribute('dir')).toBe('ltr');
    await expectNoAxeViolations(container);
  });
});

describe('OfficeDocxStage (V-25 Word)', () => {
  it('neutralises links, handlers and active elements in a rendered document', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<a href="https://evil.example" onclick="x()">a</a><a href="#note">b</a><script>x()</script>' +
      '<img src="https://tracker.example/p.gif"><img src="blob:https://app/1"><iframe></iframe>';
    neutralizeDocument(root);
    expect(root.innerHTML).toBe('<a>a</a><a href="#note">b</a><img><img src="blob:https://app/1">');
  });

  it('shows one page at a time with its pins and a page stepper', async () => {
    const onPageChange = vi.fn();
    render(
      <OfficeDocxStage
        src="https://api.example.test/f1/content"
        office={null}
        threads={[thread({ id: 't1', number: 1, pageNo: 2 })]}
        selectedThreadId={null}
        onPageChange={onPageChange}
        renderPageOverlay={(page) => <span data-testid="page-overlay">{`pins of ${page}`}</span>}
        fetcher={async () => new ArrayBuffer(8)}
      />,
    );
    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
    const sections = document.querySelectorAll<HTMLElement>('section.tm-docx');
    expect(Array.from(sections).map((section) => section.dataset['tmCurrent'])).toEqual([
      'true',
      'false',
    ]);
    expect(sections[0]?.querySelector('a')?.hasAttribute('href')).toBe(false);
    expect(sections[0]?.querySelector('a')?.hasAttribute('onclick')).toBe(false);
    expect(within(sections[0]!).getByTestId('page-overlay').textContent).toBe('pins of 1');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(sections[1]?.dataset['tmCurrent']).toBe('true'));
    expect(onPageChange).toHaveBeenLastCalledWith(2);
    expect(
      screen.getByRole('button', { name: 'Page 2, 1 open' }).getAttribute('aria-current'),
    ).toBe('true');
  });
});

describe('PsdLayersPanel (V-22)', () => {
  const psd: PreviewPsd = {
    width: 4200,
    height: 5400,
    layerCount: 4,
    groupCount: 1,
    approximate: false,
    layers: [
      {
        name: 'Headline',
        kind: 'group',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        children: [
          {
            name: 'Stay where the city slows down',
            kind: 'text',
            visible: true,
            opacity: 100,
            blendMode: 'normal',
            children: [],
          },
        ],
      },
      {
        name: 'Logo lockup',
        kind: 'smart_object',
        visible: true,
        opacity: 100,
        blendMode: 'normal',
        children: [],
      },
      {
        name: 'Lobby retouch',
        kind: 'pixel',
        visible: true,
        opacity: 60,
        blendMode: 'soft light',
        children: [],
      },
      {
        name: 'Colour grade',
        kind: 'adjustment',
        visible: false,
        opacity: 100,
        blendMode: 'normal',
        children: [],
      },
    ],
  };

  it('lists layers top first with kind, blend and opacity, and folds groups', async () => {
    const { container } = render(<PsdLayersPanel psd={psd} />);
    expect(screen.getByText('4 layers · 1 groups')).toBeTruthy();
    expect(screen.getByText('4200 × 5400 px')).toBeTruthy();
    expect(screen.getByText('Text · 100%')).toBeTruthy();
    expect(screen.getByText('Smart object')).toBeTruthy();
    expect(screen.getByText('Soft light · 60%')).toBeTruthy();
    expect(screen.getByText('Adjustment · not re-rendered')).toBeTruthy();
    expect(screen.getByLabelText(/Colour grade, .* Hidden when saved/)).toBeTruthy();
    const toggle = screen.getByRole('button', { name: 'Close group Headline' });
    fireEvent.click(toggle);
    expect(screen.queryByText('Stay where the city slows down')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Open group Headline' }).getAttribute('aria-expanded'),
    ).toBe('false');
    await expectNoAxeViolations(container);
  });

  it('says whether the preview is the saved composite or approximate', () => {
    const { rerender } = render(<PsdNotice approximate={false} />);
    expect(screen.getByText(/composite saved by Photoshop/)).toBeTruthy();
    rerender(<PsdNotice approximate />);
    expect(screen.getByText(/Preview is approximate/)).toBeTruthy();
  });
});

describe('ZipList (V-24)', () => {
  const zip: PreviewZip = {
    fileCount: 6,
    folderCount: 2,
    totalBytes: 18_400_000,
    compressedBytes: 9_000_000,
    encrypted: false,
    entries: [
      { path: 'Logos/', folder: true, sizeBytes: 0, modifiedAt: null },
      {
        path: 'Logos/a.svg',
        folder: false,
        sizeBytes: 84 * 1024,
        modifiedAt: '2026-10-28T14:05:00',
      },
      {
        path: 'Logos/b.svg',
        folder: false,
        sizeBytes: 61 * 1024,
        modifiedAt: '2026-10-28T14:05:00',
      },
      {
        path: 'Logos/c.eps',
        folder: false,
        sizeBytes: 2_200_000,
        modifiedAt: '2026-10-27T09:00:00',
      },
      { path: 'Logos/d.png', folder: false, sizeBytes: 1000, modifiedAt: null },
      { path: 'Logos/e.png', folder: false, sizeBytes: 1000, modifiedAt: null },
      { path: 'Fonts/', folder: true, sizeBytes: 0, modifiedAt: null },
      { path: 'README.txt', folder: false, sizeBytes: 2048, modifiedAt: '2026-10-30T08:00:00' },
    ],
  };

  it('builds a tree with folder counts and sizes, folders first', () => {
    const tree = zipTree(zip.entries);
    expect(tree.map((node) => [node.name, node.folder, node.fileCount])).toEqual([
      ['Fonts', true, 0],
      ['Logos', true, 5],
      ['README.txt', false, 0],
    ]);
    expect(tree[1]?.sizeBytes).toBe(84 * 1024 + 61 * 1024 + 2_200_000 + 2000);
  });

  it('shows the title, totals, the nothing-extracted line, and "N more files"', async () => {
    const { container } = render(<ZipList zip={zip} sizeBytes={9_100_000} />);
    expect(screen.getByRole('heading', { name: '6 files in 2 folders' })).toBeTruthy();
    expect(screen.getByText('17.5 MB unpacked · 8.7 MB download')).toBeTruthy();
    expect(
      screen.getByText('Nothing is extracted — download the ZIP to open these files.'),
    ).toBeTruthy();
    expect(screen.getByText('a.svg')).toBeTruthy();
    expect(screen.getAllByText('28 Oct')).toHaveLength(2);
    expect(screen.queryByText('e.png')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '2 more files' }));
    expect(screen.getByText('e.png')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Logos/ }));
    expect(screen.queryByText('a.svg')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('formats sizes up to gigabytes', () => {
    expect([500, 84 * 1024, 18_400_000, 3 * 1024 ** 3].map(formatSize)).toEqual([
      '500 B',
      '84 KB',
      '17.5 MB',
      '3.0 GB',
    ]);
  });
});

describe('UnsupportedStage (V-26)', () => {
  it('shows the file-type tile, why, the download and the facts', async () => {
    const onDownload = vi.fn();
    const { container } = render(
      <UnsupportedStage
        fileName="atlas-logo-print.eps"
        mimeType="application/postscript"
        sizeBytes={1_887_437}
        uploadedBy="Lina Samir"
        reason="eps"
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText('EPS')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'No preview for this file' })).toBeTruthy();
    expect(screen.getByText(/can't be drawn in the browser with free tools/)).toBeTruthy();
    expect(
      screen.getByText('1.8 MB · Encapsulated PostScript · uploaded by Lina Samir'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download to view' }));
    expect(onDownload).toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it('labels an embedded preview in both languages', () => {
    render(<EmbeddedPreviewChip />);
    expect(screen.getByText('Low-resolution preview from the file')).toBeTruthy();
    act(() => activeLocale.set('ar-EG'));
    expect(screen.getByText('معاينة منخفضة الدقة من الملف')).toBeTruthy();
  });
});
