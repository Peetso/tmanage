/**
 * Peter, 2026-11-09 (viewer item 8) — a small DXF reader for the in-browser drawing view.
 *
 * An ASCII DXF is a list of (group code, value) line pairs. This reads the ENTITIES section — and
 * the BLOCKS a drawing INSERTs — into flat shapes in drawing units: polylines (LINE, LWPOLYLINE,
 * POLYLINE, ARC, ELLIPSE, SPLINE control polygon, SOLID / 3DFACE outlines), circles and single-line
 * text. Hatches, dimensions and 3D solids are counted as skipped, not drawn. Bounded: at most
 * {@link MAX_SHAPES} shapes, nested blocks at most {@link MAX_BLOCK_DEPTH} deep.
 *
 * The output is data; the stage turns it into SVG elements with React (no markup strings).
 */

export interface DxfPoint {
  readonly x: number;
  readonly y: number;
}

export type DxfShape =
  | {
      readonly type: 'path';
      readonly points: readonly DxfPoint[];
      readonly closed: boolean;
      readonly color: number | null;
    }
  | {
      readonly type: 'circle';
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly color: number | null;
    }
  | {
      readonly type: 'text';
      readonly x: number;
      readonly y: number;
      readonly height: number;
      readonly rotation: number;
      readonly text: string;
      readonly color: number | null;
    };

export interface DxfBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface DxfDrawing {
  readonly shapes: readonly DxfShape[];
  readonly bounds: DxfBounds | null;
  /** Entities read but not drawn (hatches, dimensions, 3D …). */
  readonly skipped: number;
  /** `true` when {@link MAX_SHAPES} cut the drawing short. */
  readonly truncated: boolean;
}

export const MAX_SHAPES = 50_000;
export const MAX_BLOCK_DEPTH = 4;

type Pair = readonly [number, string];
type Entity = { readonly kind: string; readonly pairs: readonly Pair[] };

/** Group-code pairs of the file. A line that is not a code ends the reading (binary DXF). */
export function readPairs(text: string): Pair[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const pairs: Pair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt((lines[index] as string).trim(), 10);
    if (!Number.isFinite(code)) break;
    pairs.push([code, (lines[index + 1] as string).trim()]);
  }
  return pairs;
}

/** The entities between `0 SECTION / 2 <name>` and `0 ENDSEC`, each with its pairs. */
function sectionEntities(pairs: readonly Pair[], name: string): Entity[] {
  const entities: Entity[] = [];
  let inside = false;
  let current: { kind: string; pairs: Pair[] } | null = null;
  for (let index = 0; index < pairs.length; index += 1) {
    const [code, value] = pairs[index] as Pair;
    if (!inside) {
      if (code === 0 && value === 'SECTION') {
        const next = pairs[index + 1];
        if (next && next[0] === 2 && next[1] === name) {
          inside = true;
          index += 1;
        }
      }
      continue;
    }
    if (code === 0) {
      if (current) entities.push(current);
      if (value === 'ENDSEC') return entities;
      current = { kind: value, pairs: [] };
    } else if (current) {
      current.pairs.push([code, value]);
    }
  }
  if (current) entities.push(current);
  return entities;
}

function num(pairs: readonly Pair[], code: number, fallback = 0): number {
  const pair = pairs.find(([c]) => c === code);
  const value = pair ? Number.parseFloat(pair[1]) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
}

function str(pairs: readonly Pair[], code: number): string {
  return pairs.find(([c]) => c === code)?.[1] ?? '';
}

function colorOf(pairs: readonly Pair[]): number | null {
  const pair = pairs.find(([c]) => c === 62);
  if (!pair) return null;
  const value = Number.parseInt(pair[1], 10);
  return Number.isFinite(value) && value > 0 && value < 256 ? value : null;
}

/** Every (x, y) of the entity, in order: the repeated 10 / 20 pairs of a LWPOLYLINE. */
function vertexList(pairs: readonly Pair[]): DxfPoint[] {
  const points: DxfPoint[] = [];
  let x: number | null = null;
  for (const [code, value] of pairs) {
    if (code === 10) x = Number.parseFloat(value);
    else if (code === 20 && x !== null) {
      const y = Number.parseFloat(value);
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
      x = null;
    }
  }
  return points;
}

const DEG = Math.PI / 180;

/** An arc as points, counter-clockwise from `start` to `end` degrees. */
export function arcPoints(cx: number, cy: number, r: number, start: number, end: number) {
  let sweep = end - start;
  while (sweep <= 0) sweep += 360;
  const steps = Math.max(4, Math.ceil(sweep / 5));
  const points: DxfPoint[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const angle = (start + (sweep * step) / steps) * DEG;
    points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return points;
}

/** Strips MTEXT formatting (`\P`, `\fArial;`, braces) to plain words. */
export function plainMText(value: string): string {
  return value
    .replace(/\\P/gu, ' ')
    .replace(/\\[A-Za-z][^;\\{}]*;/gu, '')
    .replace(/\\[~]/gu, ' ')
    .replace(/[{}]/gu, '')
    .trim();
}

interface Transform {
  readonly apply: (point: DxfPoint) => DxfPoint;
  /** The uniform scale, or `null` when x and y scale differently (a circle is then a path). */
  readonly uniform: number | null;
  readonly rotation: number;
}

const IDENTITY: Transform = { apply: (p) => p, uniform: 1, rotation: 0 };

function insertTransform(pairs: readonly Pair[], parent: Transform): Transform {
  const x = num(pairs, 10);
  const y = num(pairs, 20);
  const sx = num(pairs, 41, 1);
  const sy = num(pairs, 42, 1);
  const rotation = num(pairs, 50);
  const cos = Math.cos(rotation * DEG);
  const sin = Math.sin(rotation * DEG);
  const local = (p: DxfPoint): DxfPoint => ({
    x: x + p.x * sx * cos - p.y * sy * sin,
    y: y + p.x * sx * sin + p.y * sy * cos,
  });
  const uniform =
    parent.uniform !== null && Math.abs(Math.abs(sx) - Math.abs(sy)) < 1e-9
      ? parent.uniform * Math.abs(sx)
      : null;
  return {
    apply: (p) => parent.apply(local(p)),
    uniform,
    rotation: parent.rotation + rotation,
  };
}

/** Reads a DXF's text into shapes. Never throws on a damaged file: it draws what it could read. */
export function parseDxf(text: string): DxfDrawing {
  const pairs = readPairs(text);
  const blocks = new Map<string, Entity[]>();
  // BLOCKS: `0 BLOCK … 2 <name> …`, its entities, then `0 ENDBLK`.
  let open: { name: string; entities: Entity[] } | null = null;
  for (const entity of sectionEntities(pairs, 'BLOCKS')) {
    if (entity.kind === 'BLOCK') {
      open = { name: str(entity.pairs, 2), entities: [] };
    } else if (entity.kind === 'ENDBLK') {
      if (open) blocks.set(open.name, open.entities);
      open = null;
    } else if (open) {
      open.entities.push(entity);
    }
  }

  const shapes: DxfShape[] = [];
  let skipped = 0;
  let truncated = false;
  const add = (shape: DxfShape) => {
    if (shapes.length >= MAX_SHAPES) {
      truncated = true;
      return;
    }
    shapes.push(shape);
  };
  const addPath = (points: DxfPoint[], closed: boolean, color: number | null, t: Transform) => {
    if (points.length >= 2) add({ type: 'path', points: points.map(t.apply), closed, color });
  };

  const draw = (entities: readonly Entity[], t: Transform, depth: number) => {
    for (let index = 0; index < entities.length; index += 1) {
      if (truncated) return;
      const { kind, pairs: p } = entities[index] as Entity;
      const color = colorOf(p);
      switch (kind) {
        case 'LINE':
          addPath(
            [
              { x: num(p, 10), y: num(p, 20) },
              { x: num(p, 11), y: num(p, 21) },
            ],
            false,
            color,
            t,
          );
          break;
        case 'LWPOLYLINE':
          addPath(vertexList(p), (num(p, 70) & 1) === 1, color, t);
          break;
        case 'POLYLINE': {
          const points: DxfPoint[] = [];
          let next = index + 1;
          while (next < entities.length && (entities[next] as Entity).kind === 'VERTEX') {
            const vertex = (entities[next] as Entity).pairs;
            points.push({ x: num(vertex, 10), y: num(vertex, 20) });
            next += 1;
          }
          if (next < entities.length && (entities[next] as Entity).kind === 'SEQEND') next += 1;
          addPath(points, (num(p, 70) & 1) === 1, color, t);
          index = next - 1;
          break;
        }
        case 'CIRCLE': {
          const cx = num(p, 10);
          const cy = num(p, 20);
          const r = num(p, 40);
          if (r <= 0) break;
          if (t.uniform !== null) {
            const center = t.apply({ x: cx, y: cy });
            add({ type: 'circle', cx: center.x, cy: center.y, r: r * t.uniform, color });
          } else {
            addPath(arcPoints(cx, cy, r, 0, 360), true, color, t);
          }
          break;
        }
        case 'ARC': {
          const r = num(p, 40);
          if (r > 0)
            addPath(arcPoints(num(p, 10), num(p, 20), r, num(p, 50), num(p, 51)), false, color, t);
          break;
        }
        case 'ELLIPSE': {
          const cx = num(p, 10);
          const cy = num(p, 20);
          const mx = num(p, 11);
          const my = num(p, 21);
          const ratio = num(p, 40, 1);
          const start = num(p, 41, 0);
          let end = num(p, 42, Math.PI * 2);
          if (end <= start) end += Math.PI * 2;
          const steps = Math.max(8, Math.ceil(((end - start) / (Math.PI * 2)) * 72));
          const points: DxfPoint[] = [];
          for (let step = 0; step <= steps; step += 1) {
            const a = start + ((end - start) * step) / steps;
            const u = Math.cos(a);
            const v = Math.sin(a) * ratio;
            // The minor axis is the major axis turned a quarter, scaled by the ratio.
            points.push({ x: cx + mx * u - my * v, y: cy + my * u + mx * v });
          }
          addPath(points, false, color, t);
          break;
        }
        case 'SPLINE': {
          const fit = p.filter(([c]) => c === 11 || c === 21);
          const control = vertexList(p);
          const points =
            fit.length >= 4
              ? vertexList(fit.map(([c, v]) => [c === 11 ? 10 : 20, v] as Pair))
              : control;
          addPath(points, (num(p, 70) & 1) === 1, color, t);
          break;
        }
        case 'SOLID':
        case 'TRACE':
        case '3DFACE': {
          const corners = [
            { x: num(p, 10), y: num(p, 20) },
            { x: num(p, 11), y: num(p, 21) },
            { x: num(p, 13, num(p, 12)), y: num(p, 23, num(p, 22)) },
            { x: num(p, 12), y: num(p, 22) },
          ];
          addPath(corners, true, color, t);
          break;
        }
        case 'POINT': {
          // A point is a circle of radius 0: the stage draws it as a dot of fixed screen size.
          const at = t.apply({ x: num(p, 10), y: num(p, 20) });
          add({ type: 'circle', cx: at.x, cy: at.y, r: 0, color });
          break;
        }
        case 'TEXT':
        case 'MTEXT':
        case 'ATTRIB': {
          const raw =
            kind === 'MTEXT'
              ? plainMText(
                  p
                    .filter(([c]) => c === 3 || c === 1)
                    .map(([, v]) => v)
                    .join(''),
                )
              : str(p, 1);
          const height = num(p, 40, 1) * (t.uniform ?? 1);
          const at = t.apply({ x: num(p, 10), y: num(p, 20) });
          if (raw.trim() !== '' && height > 0) {
            add({
              type: 'text',
              x: at.x,
              y: at.y,
              height,
              rotation: num(p, 50) + t.rotation,
              text: raw.slice(0, 200),
              color,
            });
          }
          break;
        }
        case 'INSERT': {
          const block = blocks.get(str(p, 2));
          if (block && depth < MAX_BLOCK_DEPTH) draw(block, insertTransform(p, t), depth + 1);
          else skipped += 1;
          break;
        }
        case 'VERTEX':
        case 'SEQEND':
        case 'ATTDEF':
          break;
        default:
          skipped += 1;
      }
    }
  };
  draw(sectionEntities(pairs, 'ENTITIES'), IDENTITY, 0);
  return { shapes, bounds: boundsOf(shapes), skipped, truncated };
}

/** The box around every shape (`null` for an empty drawing). */
export function boundsOf(shapes: readonly DxfShape[]): DxfBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const take = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const shape of shapes) {
    if (shape.type === 'path') for (const point of shape.points) take(point.x, point.y);
    else if (shape.type === 'circle') {
      take(shape.cx - shape.r, shape.cy - shape.r);
      take(shape.cx + shape.r, shape.cy + shape.r);
    } else {
      take(shape.x, shape.y);
      take(shape.x + shape.height * shape.text.length * 0.6, shape.y + shape.height);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** AutoCAD's first colours (1 red … 7 white/black); anything else draws in the ink colour. */
export function aciColor(index: number | null): string | null {
  switch (index) {
    case 1:
      return '#d33';
    case 2:
      return '#c9a400';
    case 3:
      return '#2a9d3a';
    case 4:
      return '#1b9aaa';
    case 5:
      return '#2a5bd7';
    case 6:
      return '#b03ab0';
    default:
      return null;
  }
}
