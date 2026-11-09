/**
 * Peter, 2026-11-09 (viewer item 8) — which in-browser view a file gets beyond the R4 stages.
 *
 * The API records one detected type per version (`text/plain` for every source file, DXF and IFC;
 * `text/html` for a web page; its own type for a DWG, SketchUp or Revit file). The name is what
 * tells a TypeScript file from a CSV, so the view is chosen from the extension first and the type
 * second. Pure: no React, no fetch.
 */

/** A highlighter grammar (see `code-highlight.ts`). */
export type CodeLanguage =
  | 'js'
  | 'python'
  | 'css'
  | 'json'
  | 'sql'
  | 'markdown'
  | 'yaml'
  | 'shell'
  | 'php'
  | 'go'
  | 'java'
  | 'c'
  | 'csharp'
  | 'ruby'
  | 'rust'
  | 'swift'
  | 'markup'
  | 'ini'
  | 'plain';

/** What the text stage draws for a file whose original is text. */
export type TextView =
  | { readonly view: 'html' }
  | { readonly view: 'csv'; readonly delimiter: ',' | ';' | '\t' | null }
  | { readonly view: 'dxf' }
  | { readonly view: 'code'; readonly language: CodeLanguage };

/** Desktop formats the browser cannot draw: the info card (and a thumbnail when one is inside). */
export type DesktopFormat = 'dwg' | 'skp' | 'rvt' | 'ifc' | 'legacy_office' | 'eps' | 'other';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, CodeLanguage>> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  dart: 'js',
  graphql: 'js',
  py: 'python',
  css: 'css',
  scss: 'css',
  less: 'css',
  json: 'json',
  sql: 'sql',
  md: 'markdown',
  markdown: 'markdown',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  php: 'php',
  go: 'go',
  java: 'java',
  kt: 'java',
  kts: 'java',
  c: 'c',
  h: 'c',
  cpp: 'c',
  hpp: 'c',
  cc: 'c',
  cs: 'csharp',
  rb: 'ruby',
  rs: 'rust',
  swift: 'swift',
  xml: 'markup',
  svg: 'markup',
  vue: 'markup',
  svelte: 'markup',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  conf: 'ini',
};

/** The lowercase extension of a name, without the dot (`''` when there is none). */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/** The highlighter grammar for a file name (`plain` when none fits). */
export function languageFor(fileName: string): CodeLanguage {
  return LANGUAGE_BY_EXTENSION[extensionOf(fileName)] ?? 'plain';
}

/**
 * The view for a text original, or `null` when the file is not one the text stage draws (an IFC
 * model is text, but a STEP dump says nothing to a reader: it gets the info card).
 */
export function textViewFor(fileName: string, mimeType: string | null): TextView | null {
  const extension = extensionOf(fileName);
  if (extension === 'ifc') return null;
  if (mimeType === 'text/html' || extension === 'html' || extension === 'htm') {
    return { view: 'html' };
  }
  if (extension === 'dxf') return { view: 'dxf' };
  if (mimeType === 'text/csv' || extension === 'csv') return { view: 'csv', delimiter: null };
  if (extension === 'tsv') return { view: 'csv', delimiter: '\t' };
  if (mimeType === 'text/markdown') return { view: 'code', language: 'markdown' };
  return { view: 'code', language: languageFor(fileName) };
}

/** Which desktop format a file is, from its name and type, for the info card. */
export function desktopFormatFor(fileName: string, mimeType: string | null): DesktopFormat {
  const extension = extensionOf(fileName);
  if (extension === 'dwg' || mimeType === 'image/vnd.dwg') return 'dwg';
  if (extension === 'skp' || mimeType === 'application/vnd.sketchup.skp') return 'skp';
  if (extension === 'rvt' || extension === 'rfa' || mimeType === 'application/vnd.autodesk.revit')
    return 'rvt';
  if (extension === 'ifc') return 'ifc';
  if (['doc', 'xls', 'ppt', 'dot', 'xlt', 'pot', 'pps'].includes(extension)) return 'legacy_office';
  if (extension === 'eps' || mimeType === 'application/postscript') return 'eps';
  return 'other';
}

/** Whether a desktop format may carry a preview picture the browser can show. */
export function mayCarryThumbnail(format: DesktopFormat): boolean {
  return format === 'dwg' || format === 'skp' || format === 'rvt';
}
