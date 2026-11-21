/**
 * 62-A0 — worker load proof (plan 62 §C, row 62-A0). Measures the 62-23 text extraction in one
 * Node process the way the live app runs it: one file at a time, in the same event loop that
 * answers web requests. Kept, and re-run at Gate B on live with one real file.
 *
 * What it does, in ONE run:
 *  1. Builds a deterministic corpus in memory: the 15 seed files of the benchmark workspace (plan
 *     62 §6: contracts, briefs, decks, a budget sheet, notes, one scanned PDF), one 200-page PDF of
 *     about 20 MB (text plus a 100 KB image a page) and one large XLSX (a ~60 MB sheet, deflated).
 *  2. Starts an HTTP server in this process, and a separate pinger process that sends it a GET
 *     every 20 ms: the pinger's round trips are what a web request would wait.
 *  3. Extracts each file in turn with `extractText` and the job's caps (DEFAULT_TEXT_LIMITS),
 *     recording per file: wall time, outcome, the longest event-loop stall
 *     (`monitorEventLoopDelay`), the slowest web round trip, and RSS (sampled, plus the process
 *     peak from `resourceUsage().maxRSS`).
 *  4. Fallback (1) of the plan, measured in the same run for the heavy files and any file over the
 *     stall bar: extraction in a short-lived child process with a memory cap, killed at 60 s,
 *     while this process keeps answering; the web round trips are recorded the same way.
 *
 * Run (one at a time, under heavy.lock): `npx tsx apps/api/test/ai-bench/worker-load.ts [--json out.json]`
 * Stop it at once (Ctrl+C) if the machine struggles; it holds at most one big file at a time.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  DEFAULT_TEXT_LIMITS,
  DOCX_MIME,
  PDF_MIME,
  PPTX_MIME,
  XLSX_MIME,
  extractText,
} from '../../src/modules/files/file-text-extractors.js';

const SELF = fileURLToPath(import.meta.url);
const STALL_BAR_MS = 200;
const PING_EVERY_MS = 20;
const CHILD_KILL_MS = 60_000;
const CHILD_HEAP_MB = 384;
const MB = 1024 * 1024;

// ---- deterministic content ---------------------------------------------------------------------

/** Mulberry32: the same corpus on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  'client project invoice deadline approval scope brief budget milestone delivery payment term notice party agreement services fee hours review design launch campaign report revision schedule'.split(
    ' ',
  );

function sentences(random: () => number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const length = 8 + Math.floor(random() * 12);
    const words = Array.from({ length }, () => WORDS[Math.floor(random() * WORDS.length)]!);
    out.push(`${words.join(' ')}.`);
  }
  return out.join(' ');
}

const xmlEscape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A ZIP whose parts are deflated (method 8) or stored, with real CRCs: what Office writes. */
function zip(files: Readonly<Record<string, string | Buffer>>, deflate = true): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [path, content] of Object.entries(files)) {
    const name = Buffer.from(path, 'utf8');
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const data = deflate ? deflateRawSync(raw, { level: 6 }) : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function docx(random: () => number, paragraphs: number): Buffer {
  const body = Array.from(
    { length: paragraphs },
    (_, i) =>
      `<w:p><w:r><w:t>${xmlEscape(sentences(random, 3))}</w:t></w:r></w:p>` +
      (i > 0 && i % 25 === 0 ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : ''),
  ).join('');
  return zip({ 'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>` });
}

function pptx(random: () => number, slides: number): Buffer {
  const files: Record<string, string> = {};
  for (let i = 1; i <= slides; i += 1) {
    files[`ppt/slides/slide${String(i)}.xml`] =
      `<p:sld><a:p><a:r><a:t>Slide ${String(i)} ${xmlEscape(sentences(random, 1))}</a:t></a:r></a:p>` +
      `<a:p><a:r><a:t>${xmlEscape(sentences(random, 2))}</a:t></a:r></a:p></p:sld>`;
  }
  return zip(files);
}

/** A workbook of `rows` rows (a text column from shared strings, then numbers). */
function xlsx(random: () => number, rows: number, columns: number): Buffer {
  const shared = WORDS.map((w) => `<si><t>${w}</t></si>`).join('');
  const parts: string[] = ['<worksheet><sheetData>'];
  for (let r = 1; r <= rows; r += 1) {
    let row = `<row r="${String(r)}"><c r="A${String(r)}" t="s"><v>${String(r % WORDS.length)}</v></c>`;
    for (let c = 1; c < columns; c += 1) {
      row += `<c r="${String.fromCodePoint(65 + c)}${String(r)}"><v>${(random() * 100_000).toFixed(2)}</v></c>`;
    }
    parts.push(`${row}</row>`);
  }
  parts.push('</sheetData></worksheet>');
  return zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${shared}</sst>`,
    'xl/worksheets/sheet1.xml': parts.join(''),
  });
}

/** A valid RGB PNG of noise (incompressible): about `width * height * 3` bytes. */
function noisePng(random: () => number, width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const at = y * (1 + width * 3);
    raw[at] = 0;
    for (let x = 0; x < width * 3; x += 1) raw[at + 1 + x] = Math.floor(random() * 256);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PDF: `pages` pages, `lines` text lines a page, and optionally one noise image a page. */
async function pdf(
  random: () => number,
  pages: number,
  lines: number,
  image: { width: number; height: number } | null,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p += 1) {
    const page = doc.addPage([595, 842]);
    if (image !== null) {
      const png = await doc.embedPng(noisePng(random, image.width, image.height));
      page.drawImage(png, { x: 40, y: 400, width: 500, height: 400 });
    }
    for (let l = 0; l < lines; l += 1) {
      page.drawText(sentences(random, 1).slice(0, 90), { x: 40, y: 380 - l * 14, size: 10, font });
    }
  }
  return Buffer.from(await doc.save());
}

interface CorpusFile {
  readonly name: string;
  readonly mime: string;
  readonly heavy: boolean;
  readonly build: () => Promise<Buffer>;
}

function corpus(): CorpusFile[] {
  const r = (seed: number) => prng(seed);
  const text = (seed: number, n: number) => Buffer.from(sentences(r(seed), n), 'utf8');
  return [
    // The 15 seed files (plan 62 §6: contracts, briefs, a budget sheet, one scanned PDF).
    {
      name: 'contract-acme.pdf',
      mime: PDF_MIME,
      heavy: false,
      build: () => pdf(r(1), 6, 40, null),
    },
    {
      name: 'contract-northwind.pdf',
      mime: PDF_MIME,
      heavy: false,
      build: () => pdf(r(2), 12, 40, null),
    },
    {
      name: 'contract-globex.pdf',
      mime: PDF_MIME,
      heavy: false,
      build: () => pdf(r(3), 4, 40, null),
    },
    { name: 'brief-brand.docx', mime: DOCX_MIME, heavy: false, build: async () => docx(r(4), 80) },
    {
      name: 'brief-website.docx',
      mime: DOCX_MIME,
      heavy: false,
      build: async () => docx(r(5), 140),
    },
    {
      name: 'brief-campaign.docx',
      mime: DOCX_MIME,
      heavy: false,
      build: async () => docx(r(6), 60),
    },
    { name: 'pitch-deck.pptx', mime: PPTX_MIME, heavy: false, build: async () => pptx(r(7), 24) },
    { name: 'kickoff-deck.pptx', mime: PPTX_MIME, heavy: false, build: async () => pptx(r(8), 12) },
    {
      name: 'budget-2027.xlsx',
      mime: XLSX_MIME,
      heavy: false,
      build: async () => xlsx(r(9), 400, 8),
    },
    {
      name: 'timesheet-export.csv',
      mime: 'text/csv',
      heavy: false,
      build: async () => text(10, 900),
    },
    {
      name: 'meeting-notes.md',
      mime: 'text/markdown',
      heavy: false,
      build: async () => text(11, 300),
    },
    {
      name: 'scope-change.txt',
      mime: 'text/plain',
      heavy: false,
      build: async () => text(12, 120),
    },
    {
      name: 'landing-copy.html',
      mime: 'text/html',
      heavy: false,
      build: async () =>
        Buffer.from(
          `<html><head><style>p{}</style></head><body><p>${sentences(r(13), 200)}</p></body></html>`,
        ),
    },
    {
      name: 'export.json',
      mime: 'application/json',
      heavy: false,
      build: async () => Buffer.from(JSON.stringify({ items: sentences(r(14), 400).split('. ') })),
    },
    {
      name: 'signed-scan.pdf',
      mime: PDF_MIME,
      heavy: false,
      build: () => pdf(r(15), 3, 0, { width: 400, height: 500 }),
    },
    // The two heavy files of the row.
    {
      name: 'large-200-pages.pdf',
      mime: PDF_MIME,
      heavy: true,
      build: () => pdf(r(16), 200, 20, { width: 192, height: 172 }),
    },
    {
      name: 'large-sheet.xlsx',
      mime: XLSX_MIME,
      heavy: true,
      build: async () => xlsx(r(17), 190_000, 10),
    },
  ];
}

// ---- child modes ---------------------------------------------------------------------------------

async function pinger(port: number): Promise<void> {
  const samples: [number, number][] = [];
  let running = true;
  process.on('message', (message) => {
    if (message === 'stop') {
      running = false;
      process.send?.({ samples });
      setTimeout(() => process.exit(0), 50);
    }
  });
  const once = () =>
    new Promise<void>((resolve) => {
      const sentAt = Date.now();
      const started = performance.now();
      get({ host: '127.0.0.1', port, path: '/ping', agent: false }, (res) => {
        res.resume();
        res.on('end', () => {
          samples.push([sentAt, performance.now() - started]);
          resolve();
        });
      }).on('error', () => resolve());
    });
  while (running) {
    const started = performance.now();
    await once();
    const left = PING_EVERY_MS - (performance.now() - started);
    if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
  }
}

async function extractChild(path: string, mime: string): Promise<void> {
  const bytes = new Uint8Array(readFileSync(path));
  const started = performance.now();
  const outcome = await extractText(bytes, mime, DEFAULT_TEXT_LIMITS);
  process.send?.({
    ms: performance.now() - started,
    status: outcome.status,
    code: outcome.status === 'ready' ? null : outcome.code,
    chars: outcome.status === 'ready' ? outcome.text.length : 0,
    maxRssMb: process.resourceUsage().maxRSS / 1024,
  });
  setTimeout(() => process.exit(0), 20);
}

// ---- the run ------------------------------------------------------------------------------------

interface Row {
  file: string;
  mode: 'in-process' | 'child';
  bytes: number;
  status: string;
  code: string | null;
  pages: number | null;
  chars: number;
  truncated: boolean;
  wallMs: number;
  stallMaxMs: number;
  pingMaxMs: number;
  pingCount: number;
  /** Peak RSS while extracting; its start includes the file just built (bytes and garbage). */
  rssPeakMb: number;
  rssStartMb: number;
  rssAfterMb: number;
  childMaxRssMb: number | null;
}

const rssMb = () => process.memoryUsage().rss / MB;

async function main(): Promise<void> {
  const out = process.argv.includes('--json')
    ? process.argv[process.argv.indexOf('--json') + 1]
    : undefined;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const ping: ChildProcess = fork(SELF, ['--pinger', String(port)], { stdio: 'inherit' });
  const samples = new Promise<[number, number][]>((resolve) => {
    ping.on('message', (message) => resolve((message as { samples: [number, number][] }).samples));
  });
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const baselineMb = rssMb();
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let rssPeak = 0;
  const sampler = setInterval(() => {
    rssPeak = Math.max(rssPeak, rssMb());
  }, 25);
  const windows: { row: Row; from: number; to: number }[] = [];
  const rows: Row[] = [];
  const scratch = mkdtempSync(join(tmpdir(), 'tmanage-worker-load-'));
  const bar = (row: Row) => row.stallMaxMs > STALL_BAR_MS;

  const files = corpus();
  const childQueue: { file: CorpusFile; bytes: Buffer }[] = [];
  try {
    for (const file of files) {
      let bytes: Buffer | null = await file.build();
      await new Promise((resolve) => setTimeout(resolve, 300));
      histogram.reset();
      const rssStartMb = rssMb();
      rssPeak = rssStartMb;
      const from = Date.now();
      const started = performance.now();
      const outcome = await extractText(new Uint8Array(bytes), file.mime, DEFAULT_TEXT_LIMITS);
      const wallMs = performance.now() - started;
      const to = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const row: Row = {
        file: file.name,
        mode: 'in-process',
        bytes: bytes.length,
        status: outcome.status,
        code: outcome.status === 'ready' ? null : outcome.code,
        pages: outcome.status === 'ready' ? outcome.pages : null,
        chars: outcome.status === 'ready' ? outcome.text.length : 0,
        truncated: outcome.status === 'ready' ? outcome.truncated : false,
        wallMs,
        stallMaxMs: histogram.max / 1e6,
        pingMaxMs: 0,
        pingCount: 0,
        rssPeakMb: Math.max(rssPeak, rssMb()),
        rssStartMb,
        rssAfterMb: rssMb(),
        childMaxRssMb: null,
      };
      // Pings sent during the extraction only: the next file's build (synchronous) must not count.
      windows.push({ row, from, to });
      rows.push(row);
      console.log(
        `${row.file}: ${row.status} ${Math.round(wallMs)} ms, stall ${Math.round(row.stallMaxMs)} ms, rss ${Math.round(row.rssPeakMb)} MB`,
      );
      if (file.heavy || bar(row)) childQueue.push({ file, bytes });
      bytes = null;
      // Let in-flight pings finish before the next build blocks the loop.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // Fallback (1): the same files in a short-lived child with a memory cap, at most one alive.
    for (const { file, bytes } of childQueue) {
      const path = join(scratch, file.name);
      writeFileSync(path, bytes);
      await new Promise((resolve) => setTimeout(resolve, 300));
      histogram.reset();
      const rssStartMb = rssMb();
      rssPeak = rssStartMb;
      const from = Date.now();
      const started = performance.now();
      const child = fork(SELF, ['--extract', path, file.mime], {
        execArgv: [...process.execArgv, `--max-old-space-size=${String(CHILD_HEAP_MB)}`],
        stdio: 'inherit',
      });
      const result = await new Promise<Record<string, unknown> | null>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve(null);
        }, CHILD_KILL_MS);
        child.on('message', (message) => {
          clearTimeout(timer);
          resolve(message as Record<string, unknown>);
        });
        child.on('exit', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      const wallMs = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const row: Row = {
        file: file.name,
        mode: 'child',
        bytes: bytes.length,
        status: result === null ? 'killed_or_crashed' : String(result['status']),
        code: result === null ? null : (result['code'] as string | null),
        pages: null,
        chars: result === null ? 0 : Number(result['chars']),
        truncated: false,
        wallMs,
        stallMaxMs: histogram.max / 1e6,
        pingMaxMs: 0,
        pingCount: 0,
        rssPeakMb: Math.max(rssPeak, rssMb()),
        rssStartMb,
        rssAfterMb: rssMb(),
        childMaxRssMb: result === null ? null : Number(result['maxRssMb']),
      };
      windows.push({ row, from, to: Date.now() });
      rows.push(row);
      console.log(
        `${row.file} (child): ${row.status} ${Math.round(wallMs)} ms, parent stall ${Math.round(row.stallMaxMs)} ms, child peak ${String(Math.round(row.childMaxRssMb ?? 0))} MB`,
      );
      rmSync(path, { force: true });
    }
  } finally {
    clearInterval(sampler);
    histogram.disable();
    ping.send('stop');
    rmSync(scratch, { recursive: true, force: true });
  }
  const pings = await samples;
  for (const { row, from, to } of windows) {
    const inside = pings.filter(([sentAt]) => sentAt >= from && sentAt <= to);
    row.pingCount = inside.length;
    row.pingMaxMs = inside.reduce((max, [, ms]) => Math.max(max, ms), 0);
  }
  server.close();
  const summary = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    baselineRssMb: baselineMb,
    processMaxRssMb: process.resourceUsage().maxRSS / 1024,
    limits: DEFAULT_TEXT_LIMITS,
    stallBarMs: STALL_BAR_MS,
    rows,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (out !== undefined) writeFileSync(out, JSON.stringify(summary, null, 2));
}

const mode = process.argv[2];
if (mode === '--pinger') void pinger(Number(process.argv[3]));
else if (mode === '--extract') void extractChild(process.argv[3]!, process.argv[4]!);
else void main();
