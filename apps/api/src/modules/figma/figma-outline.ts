import type { FigmaFrameRow } from '../../common/database/schema.js';
import {
  MAX_CAPTURED_FRAMES,
  type FigmaNodeSummary,
  type FigmaOutline,
  type FigmaOutlineFrame,
  type FigmaOutlinePage,
} from './figma.rest.js';

/**
 * Peter, 2026-11-10 — which frames of a Figma file a link lists and captures, and what a "Refresh
 * from Figma" changes. Pure: no database, no Figma calls.
 *
 * A link lists every frame of the file (the outline). It captures — draws and stores a snapshot
 * of — at most {@link MAX_CAPTURED_FRAMES}, in order of relevance: the frame the pasted link
 * pointed at, then the other frames of its page, then the rest of the file in Figma's order. When
 * the team chose pages (a file over the limit), only frames on those pages are captured. A frame
 * beyond the limit is listed as `skipped`, so the viewer can say how many exist and how many are
 * captured; it is never silently left out.
 */

export type FigmaCaptureMode = 'whole_file' | 'picked';

/** A frame as the planner sees it: from Figma's outline, or from a stored row. */
export interface PlannedFrame {
  readonly nodeId: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly x: number | null;
  readonly y: number | null;
  readonly pageId: string | null;
  readonly pageName: string | null;
  readonly sectionName: string | null;
}

/** Where a frame stands after planning. */
export interface FramePlacement {
  /** Figma's order (the viewer's order). */
  readonly sortOrder: number;
  /** The snapshot job's order. */
  readonly captureRank: number;
  readonly captured: boolean;
}

/** What the link stores of the outline beyond its frames. */
export interface StoredOutline {
  readonly pages: readonly FigmaOutlinePage[];
  readonly truncated: boolean;
}

export function fromOutline(frame: FigmaOutlineFrame): PlannedFrame {
  return {
    nodeId: frame.nodeId,
    name: frame.name,
    width: frame.width,
    height: frame.height,
    x: frame.x,
    y: frame.y,
    pageId: frame.pageId,
    pageName: frame.pageName,
    sectionName: frame.sectionName,
  };
}

/** A frame Figma named directly (a nested frame a link pointed at): no page, no position. */
export function fromNode(node: FigmaNodeSummary): PlannedFrame {
  return {
    nodeId: node.nodeId,
    name: node.name,
    width: node.width,
    height: node.height,
    x: null,
    y: null,
    pageId: null,
    pageName: node.pageName,
    sectionName: null,
  };
}

export function fromRow(row: FigmaFrameRow): PlannedFrame {
  return {
    nodeId: row.nodeId,
    name: row.name,
    width: row.width,
    height: row.height,
    x: row.posX,
    y: row.posY,
    pageId: row.pageId,
    pageName: row.pageName,
    sectionName: row.sectionName,
  };
}

/**
 * Order and capture for the listed frames. `frames` is in Figma's order. `focus` is the node the
 * link pointed at (a frame or a page id). `pageFilter` (page ids) limits capture to those pages;
 * `null` is every page.
 */
export function placeFrames(
  frames: readonly PlannedFrame[],
  focus: string | null,
  pageFilter: ReadonlySet<string> | null,
  limit: number = MAX_CAPTURED_FRAMES,
): ReadonlyMap<string, FramePlacement> {
  const focusFrame = focus ? frames.find((frame) => frame.nodeId === focus) : undefined;
  const focusPage =
    focusFrame?.pageId ?? (focus && frames.some((f) => f.pageId === focus) ? focus : null);
  const first = (frame: PlannedFrame): number =>
    frame.nodeId === focusFrame?.nodeId
      ? 0
      : focusPage !== null && frame.pageId === focusPage
        ? 1
        : 2;
  const byRelevance = frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => first(a.frame) - first(b.frame) || a.index - b.index);
  const out = new Map<string, FramePlacement>();
  let captured = 0;
  byRelevance.forEach(({ frame, index }, rank) => {
    const wanted = pageFilter === null || (frame.pageId !== null && pageFilter.has(frame.pageId));
    const take = wanted && captured < limit;
    if (take) captured += 1;
    out.set(frame.nodeId, { sortOrder: index, captureRank: rank, captured: take });
  });
  return out;
}

export interface FrameChange {
  readonly row: FigmaFrameRow;
  readonly frame: PlannedFrame;
  readonly placement: FramePlacement;
  /** The frame's size in Figma differs from the stored one ("Frame changed"). */
  readonly sizeChanged: boolean;
}

export interface FrameDiff {
  readonly inserts: readonly { readonly frame: PlannedFrame; readonly placement: FramePlacement }[];
  readonly updates: readonly FrameChange[];
  /** Stored frames Figma no longer has: kept with their threads, marked gone. */
  readonly gone: readonly FigmaFrameRow[];
}

/**
 * "Refresh from Figma": the stored frames against the file as it is now, matched by Figma node
 * id (a frame renamed or moved keeps its row, so its comment threads stay on it).
 */
export function diffFrames(
  rows: readonly FigmaFrameRow[],
  frames: readonly PlannedFrame[],
  placements: ReadonlyMap<string, FramePlacement>,
): FrameDiff {
  const byNode = new Map(rows.map((row) => [row.nodeId, row]));
  const seen = new Set<string>();
  const inserts: { frame: PlannedFrame; placement: FramePlacement }[] = [];
  const updates: FrameChange[] = [];
  for (const frame of frames) {
    const placement = placements.get(frame.nodeId);
    if (!placement || seen.has(frame.nodeId)) continue;
    seen.add(frame.nodeId);
    const row = byNode.get(frame.nodeId);
    if (!row) {
      inserts.push({ frame, placement });
      continue;
    }
    const sizeChanged =
      row.capturedAt !== null &&
      row.width > 0 &&
      (row.width !== frame.width || row.height !== frame.height);
    updates.push({ row, frame, placement, sizeChanged });
  }
  const gone = rows.filter((row) => !seen.has(row.nodeId) && row.goneAt === null);
  return { inserts, updates, gone };
}

/** The outline's page list and cut-off as the link stores it. */
export function storedOutlineJson(outline: Pick<FigmaOutline, 'pages' | 'truncated'>): string {
  return JSON.stringify({
    pages: outline.pages.map((page) => ({ id: page.id, name: page.name })),
    truncated: outline.truncated,
  });
}

function stringField(value: unknown, max: number): string | null {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : null;
}

/** The stored outline, read defensively (a link made before 0342 has none). */
export function parseStoredOutline(raw: string | null): StoredOutline {
  if (raw === null) return { pages: [], truncated: false };
  try {
    const value = JSON.parse(raw) as { pages?: unknown; truncated?: unknown };
    const pages: FigmaOutlinePage[] = [];
    for (const entry of Array.isArray(value.pages) ? value.pages : []) {
      const record = entry as { id?: unknown; name?: unknown };
      const id = stringField(record.id, 64);
      if (id) pages.push({ id, name: stringField(record.name, 300) ?? id });
    }
    return { pages, truncated: value.truncated === true };
  } catch {
    return { pages: [], truncated: false };
  }
}

/** The page filter as stored: a JSON list of page ids, or null for every page. */
export function parsePageFilter(raw: string | null): ReadonlySet<string> | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return null;
    return new Set(
      value.filter((id): id is string => typeof id === 'string').map((id) => id.slice(0, 64)),
    );
  } catch {
    return null;
  }
}
