import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodeView,
  CsvView,
  DesktopFileStage,
  DxfView,
  HtmlView,
  TextFileStage,
} from '../src/components/viewer/FileTextStages';
import { stageFor } from '../src/components/viewer/FileViewer';
import { highlightLines, tokenize } from '../src/components/viewer/code-highlight';
import { guessDelimiter, parseCsv } from '../src/components/viewer/csv-parse';
import { arcPoints, parseDxf, plainMText, readPairs } from '../src/components/viewer/dxf-parse';
import { findEmbeddedPng } from '../src/components/viewer/embedded-thumbnail';
import {
  desktopFormatFor,
  languageFor,
  mayCarryThumbnail,
  textViewFor,
} from '../src/components/viewer/file-formats';
import type { FilePreviewManifest } from '../src/lib/api/file-preview';
import { attachmentMimeType } from '../src/lib/api/uploads';
import { expectNoAxeViolations } from './axe';

/**
 * Peter, 2026-11-09 (viewer item 8) — viewers for what an agency uploads: kind detection, the
 * code highlighter, CSV, the DXF reader, the sandboxed HTML preview and the desktop-format card.
 */

const dxf = (...pairs: (string | number)[]) => {
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) lines.push(`  ${pairs[i]}`, String(pairs[i + 1]));
  return `${lines.join('\n')}\n`;
};

const SAMPLE_DXF = dxf(
  0,
  'SECTION',
  2,
  'BLOCKS',
  0,
  'BLOCK',
  2,
  'DOOR',
  10,
  0,
  20,
  0,
  0,
  'LINE',
  10,
  0,
  20,
  0,
  11,
  1,
  21,
  0,
  0,
  'ENDBLK',
  0,
  'ENDSEC',
  0,
  'SECTION',
  2,
  'ENTITIES',
  0,
  'LINE',
  8,
  '0',
  10,
  0,
  20,
  0,
  11,
  100,
  21,
  0,
  0,
  'LWPOLYLINE',
  90,
  3,
  70,
  1,
  10,
  0,
  20,
  0,
  10,
  50,
  20,
  0,
  10,
  50,
  20,
  40,
  0,
  'CIRCLE',
  62,
  1,
  10,
  50,
  20,
  50,
  40,
  10,
  0,
  'ARC',
  10,
  0,
  20,
  0,
  40,
  5,
  50,
  0,
  51,
  90,
  0,
  'POLYLINE',
  70,
  0,
  0,
  'VERTEX',
  10,
  1,
  20,
  1,
  0,
  'VERTEX',
  10,
  2,
  20,
  3,
  0,
  'SEQEND',
  0,
  'TEXT',
  10,
  5,
  20,
  5,
  40,
  2.5,
  1,
  'Living room',
  0,
  'INSERT',
  2,
  'DOOR',
  10,
  10,
  20,
  10,
  41,
  2,
  42,
  2,
  0,
  'HATCH',
  10,
  0,
  20,
  0,
  0,
  'ENDSEC',
  0,
  'EOF',
);

function manifest(overrides: Record<string, unknown>): FilePreviewManifest {
  return {
    media: null,
    file: { id: 'f1', name: 'app.ts', projectId: 'p1' },
    version: { fileVersionId: 'fv1', mimeType: 'text/plain', sizeBytes: 10, scanStatus: 'clean' },
    kind: 'text',
    status: 'ready',
    derivatives: [],
    originalUrl: '/v1/organizations/o/files/f1/content',
    pages: null,
    durationMs: null,
    approximate: false,
    linkedImagesRemoved: false,
    embeddedPreview: false,
    psd: null,
    zip: null,
    fig: null,
    office: null,
    versions: { rootFileAssetId: 'f1', versions: [] },
    decisionContext: { kind: 'file', deliverableId: null, deliverableVersionId: null },
    capabilities: {
      canReview: true,
      canComment: true,
      canDraw: true,
      canResolve: true,
      canDecide: true,
      canUploadVersion: true,
      canDownload: true,
      canRetry: true,
      canDelete: false,
    },
    ...overrides,
  } as FilePreviewManifest;
}

const named = (name: string, mimeType: string | null, kind: string) =>
  stageFor(
    manifest({
      kind,
      file: { id: 'f1', name, projectId: 'p1' },
      version: { fileVersionId: 'fv1', mimeType, sizeBytes: 10, scanStatus: 'clean' },
    }),
  ).stage;

describe('which view a file gets', () => {
  it('reads the view from the name first and the detected type second', () => {
    expect(textViewFor('app.tsx', 'text/plain')).toEqual({ view: 'code', language: 'js' });
    expect(textViewFor('main.py', 'text/plain')).toEqual({ view: 'code', language: 'python' });
    expect(textViewFor('notes', 'text/markdown')).toEqual({ view: 'code', language: 'markdown' });
    expect(textViewFor('budget.csv', 'text/csv')).toEqual({ view: 'csv', delimiter: null });
    expect(textViewFor('site.html', 'text/html')).toEqual({ view: 'html' });
    expect(textViewFor('page', 'text/html')).toEqual({ view: 'html' });
    expect(textViewFor('plan.DXF', 'text/plain')).toEqual({ view: 'dxf' });
    expect(textViewFor('model.ifc', 'text/plain')).toBeNull();
    expect(languageFor('query.sql')).toBe('sql');
    expect(languageFor('readme')).toBe('plain');
    expect(desktopFormatFor('plan.dwg', 'image/vnd.dwg')).toBe('dwg');
    expect(desktopFormatFor('house.skp', null)).toBe('skp');
    expect(desktopFormatFor('tower.rfa', null)).toBe('rvt');
    expect(desktopFormatFor('old.xls', null)).toBe('legacy_office');
    expect(desktopFormatFor('logo.eps', 'application/postscript')).toBe('eps');
    expect(mayCarryThumbnail('dwg')).toBe(true);
    expect(mayCarryThumbnail('ifc')).toBe(false);
  });

  it('picks the text stage for code, CSV, HTML and DXF, and the desktop card for CAD and BIM', () => {
    expect(named('app.ts', 'text/plain', 'text')).toBe('text');
    expect(named('rates.csv', 'text/csv', 'text')).toBe('text');
    expect(named('site.html', 'text/html', 'text')).toBe('text');
    expect(named('plan.dxf', 'text/plain', 'text')).toBe('text');
    expect(named('model.ifc', 'text/plain', 'text')).toBe('desktop');
    expect(named('plan.dwg', 'image/vnd.dwg', 'unsupported')).toBe('desktop');
    expect(named('house.skp', 'application/vnd.sketchup.skp', 'unsupported')).toBe('desktop');
    // An EPS keeps its own card, and an unknown type the plain one.
    expect(named('logo.eps', 'application/postscript', 'unsupported')).toBe('unsupported');
    expect(named('blob.bin', 'application/octet-stream', 'unsupported')).toBe('unsupported');
    // A modern Illustrator file is a PDF and opens in the PDF stage.
    expect(named('poster.ai', 'application/pdf', 'pdf')).toBe('pdf');
    // Still checked first: nothing is fetched while the scan runs.
    expect(stageFor(manifest({ status: 'pending', originalUrl: null })).state).toBe('checking');
  });

  it('declares code, DXF and IFC as text, and HTML / DWG / SketchUp / Revit as themselves', () => {
    const declared = (name: string, type = '') => attachmentMimeType({ name, size: 1, type });
    expect(declared('app.ts', 'video/mp2t')).toBe('text/plain');
    expect(declared('data.json', 'application/json')).toBe('text/plain');
    expect(declared('plan.dxf', 'image/vnd.dxf')).toBe('text/plain');
    expect(declared('model.ifc')).toBe('text/plain');
    expect(declared('site.html', 'text/html')).toBe('text/html');
    expect(declared('plan.dwg')).toBe('image/vnd.dwg');
    expect(declared('house.skp')).toBe('application/vnd.sketchup.skp');
    expect(declared('tower.rvt')).toBe('application/vnd.autodesk.revit');
    // The API refuses scripts a machine runs; the picker says so before any byte moves.
    expect(declared('deploy.sh')).toBeNull();
    expect(declared('app.js', 'text/javascript')).toBeNull();
    expect(declared('legacy.doc', 'application/msword')).toBeNull();
  });
});

describe('the code highlighter', () => {
  it('types comments, strings, numbers and keywords, and keeps every character', () => {
    const source = 'const total = 42; // sum\nlet name = "Lina";';
    const tokens = tokenize(source, 'js');
    expect(tokens.map((t) => t.text).join('')).toBe(source);
    const kinds = Object.fromEntries(tokens.map((t) => [t.text.trim(), t.kind]));
    expect(kinds['const']).toBe('keyword');
    expect(kinds['42']).toBe('number');
    expect(kinds['// sum']).toBe('comment');
    expect(kinds['"Lina"']).toBe('string');
    // An identifier holding a keyword is not one.
    expect(tokenize('constant', 'js')).toEqual([{ kind: 'plain', text: 'constant' }]);
  });

  it('knows Python, SQL (any case), JSON keys, YAML keys, Markdown headings and markup tags', () => {
    expect(tokenize('def f():\n    """doc"""', 'python').map((t) => t.kind)).toContain('string');
    expect(tokenize('select * FROM t', 'sql').filter((t) => t.kind === 'keyword')).toHaveLength(2);
    expect(tokenize('{"name": "a", "n": 1}', 'json').filter((t) => t.kind === 'key')).toHaveLength(
      2,
    );
    expect(tokenize('title: Hello # note', 'yaml')).toEqual(
      expect.arrayContaining([
        { kind: 'key', text: 'title' },
        { kind: 'comment', text: ' # note' },
      ]),
    );
    expect(tokenize('# Brief\ntext', 'markdown')[0]).toEqual({ kind: 'heading', text: '# Brief' });
    const markup = tokenize('<a href="x">Hi</a><!-- c -->', 'markup');
    expect(markup).toEqual(
      expect.arrayContaining([
        { kind: 'tag', text: '<a' },
        { kind: 'attr', text: 'href' },
        { kind: 'string', text: '"x"' },
        { kind: 'comment', text: '<!-- c -->' },
      ]),
    );
  });

  it('splits a block comment over the lines it spans', () => {
    const lines = highlightLines('a\r\n/* one\ntwo */ b', 'js');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual([{ kind: 'comment', text: '/* one' }]);
    expect(lines[2]?.[0]).toEqual({ kind: 'comment', text: 'two */' });
  });

  it('renders numbered lines as text, never as markup', async () => {
    const { container } = render(
      <CodeView
        text={'<img src=x onerror=alert(1)>\nconst a = 1;'}
        fileName="x.ts"
        language="js"
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('.tm-code__line')).toHaveLength(2);
    expect(container.querySelector('[data-token="keyword"]')?.textContent).toBe('const');
    expect(screen.getByLabelText('x.ts, 2 lines')).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('CSV', () => {
  it('reads quotes, doubled quotes, line breaks in quotes and the separator', () => {
    expect(guessDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(guessDelimiter('a\tb')).toBe('\t');
    const table = parseCsv('﻿name,note\r\n"Lina","said ""hi""\nthen left"\nOmar,');
    expect(table.rows).toEqual([
      ['name', 'note'],
      ['Lina', 'said "hi"\nthen left'],
      ['Omar', ''],
    ]);
    expect(table.columns).toBe(2);
    expect(table.truncated).toBe(false);
  });

  it('draws a table with the first row as the header', () => {
    render(
      <CsvView text={'Item,Cost\nLogo,1200\nSite,4800'} fileName="quote.csv" delimiter={null} />,
    );
    expect(screen.getByRole('table', { name: 'Table of quote.csv' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '4800' })).toHaveAttribute('data-numeric', 'true');
  });
});

describe('the DXF reader', () => {
  it('reads group-code pairs and stops at a line that is not a code', () => {
    expect(readPairs('  0\nSECTION\n  2\nENTITIES\nAutoCAD Binary DXF\n')).toEqual([
      [0, 'SECTION'],
      [2, 'ENTITIES'],
    ]);
  });

  it('draws lines, polylines, circles, arcs, text and inserted blocks, and counts the rest', () => {
    const drawing = parseDxf(SAMPLE_DXF);
    const types = drawing.shapes.map((shape) => shape.type);
    expect(types.filter((t) => t === 'path')).toHaveLength(5);
    expect(types).toContain('circle');
    expect(types).toContain('text');
    const poly = drawing.shapes[1];
    expect(poly).toMatchObject({ type: 'path', closed: true });
    expect(drawing.shapes.find((s) => s.type === 'circle')).toMatchObject({ r: 10, color: 1 });
    // The DOOR block's line, scaled by 2 and moved to (10, 10).
    expect(drawing.shapes.at(-1)).toMatchObject({
      type: 'path',
      points: [
        { x: 10, y: 10 },
        { x: 12, y: 10 },
      ],
    });
    expect(drawing.skipped).toBe(1);
    expect(drawing.bounds).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 60 });
  });

  it('turns an arc counter-clockwise and strips MTEXT formatting', () => {
    const points = arcPoints(0, 0, 1, 0, 90);
    expect(points[0]?.x).toBeCloseTo(1);
    expect(points.at(-1)?.y).toBeCloseTo(1);
    expect(plainMText('{\\fArial|b1;Room}\\PKitchen')).toBe('Room Kitchen');
  });

  it('never throws on a damaged file and draws nothing from nothing', () => {
    expect(parseDxf('garbage').shapes).toEqual([]);
    expect(parseDxf('').bounds).toBeNull();
  });

  it('draws the drawing as SVG elements with zoom buttons', () => {
    const { container } = render(<DxfView text={SAMPLE_DXF} fileName="plan.dxf" />);
    expect(screen.getByRole('img', { name: 'Drawing of plan.dxf' })).toBeInTheDocument();
    expect(container.querySelectorAll('polyline, polygon').length).toBeGreaterThan(3);
    expect(container.querySelector('text')?.textContent).toBe('Living room');
    expect(
      screen.getByText('1 items (hatches, dimensions or 3D parts) are not drawn here.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Fit to screen' })).toHaveTextContent('150%');
  });
});

describe('the HTML preview', () => {
  const created: string[] = [];
  beforeEach(() => {
    created.length = 0;
    URL.createObjectURL = vi.fn(() => {
      created.push('blob:http://localhost/page');
      return 'blob:http://localhost/page';
    });
    URL.revokeObjectURL = vi.fn();
  });

  it('frames the page with an empty sandbox from a blob, with no script or srcdoc', async () => {
    const page = '<html><body><h1>Launch</h1><script>alert(1)</script></body></html>';
    const { container } = render(<HtmlView text={page} fileName="launch.html" />);
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('');
    expect(frame?.hasAttribute('srcdoc')).toBe(false);
    expect(frame?.getAttribute('src')).toBe('blob:http://localhost/page');
    expect(frame).toHaveAccessibleName('Preview of launch.html');
    // The file's script is never part of this document.
    expect(container.querySelector('script')).toBeNull();
    expect(document.querySelectorAll('script')).toHaveLength(0);
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Blob;
    expect(blob.type).toBe('text/html');
  });

  it('shows the source as highlighted text and revokes the blob', () => {
    const page = '<p class="x">Hi</p>';
    const { container, unmount } = render(<HtmlView text={page} fileName="a.html" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(container.querySelector('iframe')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/page');
    expect(container.querySelector('[data-token="tag"]')?.textContent).toBe('<p');
    expect(container.querySelector('p.x')).toBeNull();
    unmount();
  });
});

describe('the text stage', () => {
  it('reads the original and draws its view, or offers the download when it cannot', async () => {
    const encoder = new TextEncoder();
    const ok = vi.fn(async () => encoder.encode('SELECT 1;').buffer as ArrayBuffer);
    render(
      <TextFileStage
        src="https://api/x"
        fileName="q.sql"
        mimeType="text/plain"
        view={{ view: 'code', language: 'sql' }}
        fetcher={ok}
      />,
    );
    expect(await screen.findByText('SELECT')).toHaveAttribute('data-token', 'keyword');
    const download = vi.fn();
    render(
      <TextFileStage
        src="https://api/y"
        fileName="q.sql"
        mimeType="text/plain"
        view={{ view: 'code', language: 'sql' }}
        fetcher={async () => {
          throw new Error('nope');
        }}
        onDownload={download}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Download to view' }));
    expect(download).toHaveBeenCalled();
  });
});

function png(): Uint8Array {
  const chunk = (type: string, length: number) => {
    const out = new Uint8Array(12 + length);
    new DataView(out.buffer).setUint32(0, length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    return out;
  };
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', 13),
    chunk('IDAT', 300),
    chunk('IEND', 0),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

describe('the picture saved inside a CAD file', () => {
  it('finds the whole PNG and nothing else', () => {
    const picture = png();
    const file = new Uint8Array(1000 + picture.length + 50);
    file.set([0x41, 0x43, 0x31, 0x30, 0x33, 0x32]);
    file.set(picture, 1000);
    expect(findEmbeddedPng(file)).toEqual(picture);
    // Cut off before IEND: not a picture.
    expect(findEmbeddedPng(file.subarray(0, 1000 + picture.length - 5))).toBeNull();
    expect(findEmbeddedPng(new Uint8Array(64))).toBeNull();
  });
});

describe('the desktop-format card', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/thumb');
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.restoreAllMocks());

  it('names the file, its size and type, the apps that open it, and the download', async () => {
    const download = vi.fn();
    const { container } = render(
      <DesktopFileStage
        src="https://api/plan"
        fileName="ground-floor.dwg"
        mimeType="image/vnd.dwg"
        sizeBytes={2_400_000}
        onDownload={download}
        read={async () => new Uint8Array(32)}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No preview for this file' })).toBeInTheDocument();
    expect(screen.getByText('ground-floor.dwg · 2.3 MB · AutoCAD drawing')).toBeInTheDocument();
    expect(
      screen.getByText('Opens in AutoCAD, or in the free Autodesk DWG TrueView.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Download to view' }));
    expect(download).toHaveBeenCalled();
    expect(container.querySelector('img')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('shows the preview picture the file carries', async () => {
    const picture = png();
    render(
      <DesktopFileStage
        src="https://api/house"
        fileName="house.skp"
        mimeType="application/vnd.sketchup.skp"
        sizeBytes={10}
        read={async () => picture}
      />,
    );
    const img = await screen.findByRole('img', { name: 'Preview picture saved inside house.skp' });
    expect(img).toHaveAttribute('src', 'blob:http://localhost/thumb');
    expect(screen.getByText('Preview saved inside the file')).toBeInTheDocument();
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1));
  });

  it('does not read an IFC model looking for a picture', () => {
    const read = vi.fn(async () => new Uint8Array(0));
    render(
      <DesktopFileStage
        src="https://api/m"
        fileName="tower.ifc"
        mimeType="text/plain"
        sizeBytes={10}
        read={read}
      />,
    );
    expect(read).not.toHaveBeenCalled();
    expect(screen.getByText(/BIMcollab Zoom/u)).toBeInTheDocument();
  });
});
