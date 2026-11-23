/**
 * The layout invariants of Density v2 (ADR-0016, UX-26…UX-28), measured in a real browser.
 *
 * `measureLayout` runs inside the page (`page.evaluate(measureLayout, options)`), so it is one
 * self-contained function: Playwright sends its source text, nothing it closes over. It reads
 * boxes and text ranges, never class names of particular screens, so a rule holds for every
 * screen and a new screen is covered without being listed. The rules are the doc-frame rules of
 * Figma `918:2052`:
 *
 * - `gutter`         content beside the rail starts at least `gutter` px from it (rule 3)
 * - `capsule-inset`  text in a capsule sits ≥ 16px and ≥ half the height (capped at the 24px
 *                    container inset) from each rounded end (rule 1)
 * - `control-inset`  text in a boxed control sits ≥ 12px from its inline edges (rule 1)
 * - `container-inset` text in a card, panel or dialog sits ≥ 24px from its edges (rule 1)
 * - `header-height`  every control in the page header row has one height (rule 2)
 * - `text-size`      no visible text below 11px (rule 4)
 * - `target-size`    every pointer target is at least 24 × 24 (rule 4, WCAG 2.2 SC 2.5.8)
 * - `label-cut`      a destination label in the shell's primary navigation (the rail, the phone
 *                    dock) is cut with an ellipsis: "M…" names no destination (review WX1 1)
 *
 * What counts as "the shape behind the text" (refined in design sweep 2, 2026-11-23, so the count
 * is of real defects, not of measuring artefacts):
 * - a shape is a box with a background or a visible inline-side border; a transparent border and
 *   a top/bottom rule alone (an underlined tab, a section line) draw no edge beside the text;
 * - text is measured against its nearest shape: card text that sits on a band, a capsule or a
 *   nested card inside the card is measured there, and table-cell text keeps the cell inset;
 * - text is measured where it shows: cut to every clipping box (ellipsis, scrolled panels), and a
 *   scrolling axis of a panel is a viewport, not an inset;
 * - a square glyph box up to 64px (initials in a circle, a numbered pin) centres its glyph and has
 *   no rounded end; it is still measured as a target.
 */

export type LayoutRule =
  | 'gutter'
  | 'capsule-inset'
  | 'control-inset'
  | 'container-inset'
  | 'header-height'
  | 'text-size'
  | 'target-size'
  | 'label-cut';

export interface LayoutViolation {
  readonly rule: LayoutRule;
  /** A short, stable description of the element: tag and first class names. */
  readonly where: string;
  /** What was measured, in CSS px. */
  readonly measured: number;
  readonly required: number;
  /** For a container inset: the edge of the box that the text is too close to. */
  readonly side?: 'left' | 'right' | 'top' | 'bottom';
}

export interface LayoutOptions {
  /** Where to look; defaults to the whole document. */
  readonly root?: string;
  /** Fallback when the page does not define `--page-gutter`. */
  readonly gutter: number;
  readonly capsuleInset: number;
  readonly controlInset: number;
  readonly containerInset: number;
  readonly minText: number;
  readonly minTarget: number;
}

export const DENSITY_V2: LayoutOptions = {
  gutter: 32,
  capsuleInset: 16,
  controlInset: 12,
  containerInset: 24,
  minText: 11,
  minTarget: 24,
};

export function measureLayout(options: LayoutOptions): LayoutViolation[] {
  const out: LayoutViolation[] = [];
  const scope: ParentNode = options.root
    ? (document.querySelector(options.root) ?? document)
    : document;
  const round = (n: number) => Math.round(n * 10) / 10;

  const describe = (el: Element): string => {
    const classes = [...el.classList].filter((c) => c.startsWith('tm-')).slice(0, 2);
    return `${el.tagName.toLowerCase()}${classes.map((c) => `.${c}`).join('')}`;
  };

  const visible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    // Visually hidden helpers (clip, 1px boxes) are for assistive technology only.
    return !(style.position === 'absolute' && r.width <= 1 && r.height <= 1);
  };

  /** The union box of an element's own text (direct text nodes only), or null. */
  const ownTextRect = (el: Element): DOMRect | null => {
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width < 1) continue;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
    }
    return Number.isFinite(left) ? new DOMRect(left, top, right - left, bottom - top) : null;
  };

  /**
   * The part of a text box that can be seen: cut to the content box of every box from `from` up
   * to `to` that clips its overflow. Text cut with an ellipsis, or scrolled out of a panel, is
   * measured where it shows, not where its glyphs would run on to. Null when none of it shows.
   */
  const clipped = (rect: DOMRect, from: Element, to: Element): DOMRect | null => {
    let { left, right, top, bottom } = rect;
    for (let node: Element | null = from; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
        const b = node.getBoundingClientRect();
        const cl = b.left + node.clientLeft + (parseFloat(s.paddingLeft) || 0);
        const ct = b.top + node.clientTop + (parseFloat(s.paddingTop) || 0);
        const cr = b.left + node.clientLeft + node.clientWidth - (parseFloat(s.paddingRight) || 0);
        const cb = b.top + node.clientTop + node.clientHeight - (parseFloat(s.paddingBottom) || 0);
        if (s.overflowX !== 'visible') {
          left = Math.max(left, cl);
          right = Math.min(right, cr);
        }
        if (s.overflowY !== 'visible') {
          top = Math.max(top, ct);
          bottom = Math.min(bottom, cb);
        }
      }
      if (node === to) break;
    }
    return right - left >= 1 && bottom - top >= 1
      ? new DOMRect(left, top, right - left, bottom - top)
      : null;
  };

  /**
   * Whether `c` sits on a shape of its own inside `el`: a drawn box (a band, a capsule, a nested
   * card) or a table cell between `c` and `el`. Such text is measured against that nearer shape
   * (rule 1 is "text from the edge of the shape behind it"); a cell keeps its own inset
   * (`--inset-cell`, 12), so a table that is its own card is not held to the card's 24.
   */
  const onInnerShape = (c: Element, el: Element): boolean => {
    for (let node: Element | null = c; node && node !== el; node = node.parentElement) {
      if (node.matches('td, th') || drawn(node)) return true;
    }
    return false;
  };

  /**
   * The text box of an element: its own text, or the text of the elements that hold it. With
   * `directOnly`, only the text whose nearest shape is this element (see `onInnerShape`).
   */
  const textRect = (el: Element, directOnly = false): DOMRect | null => {
    const own = ownTextRect(el);
    if (own) return clipped(own, el, el);
    const rects = [...el.querySelectorAll('*')]
      .filter((c) => visible(c) && !(directOnly && onInnerShape(c, el)))
      .map((c) => {
        const r = ownTextRect(c);
        return r ? clipped(r, c, el) : null;
      })
      .filter((r): r is DOMRect => r !== null);
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  };

  /** A colour that paints something: not `transparent` and not fully see-through. */
  const painted = (color: string): boolean =>
    color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color.replace(/\s+/g, ' '));

  /**
   * A box is drawn when it has a background, or a visible border on an inline side. A border in a
   * transparent colour (a text button keeps one so its hover state does not move the label) draws
   * no edge. A box drawn only by a top or bottom line (an underlined tab, a section rule) is a
   * separator, not a shape around its text, so it has no edge for the text to crowd.
   */
  const drawn = (el: Element): boolean => {
    const s = getComputedStyle(el);
    const border = ['right', 'left'].some(
      (side) =>
        parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0 &&
        s.getPropertyValue(`border-${side}-style`) !== 'none' &&
        painted(s.getPropertyValue(`border-${side}-color`)),
    );
    const filled = painted(s.backgroundColor);
    return border || filled || s.backgroundImage !== 'none';
  };

  /** A box whose content scrolls on an axis: its edges on that axis are a viewport, not padding. */
  const scrolls = (el: Element, axis: 'x' | 'y'): boolean => {
    const s = getComputedStyle(el);
    const overflow = axis === 'x' ? s.overflowX : s.overflowY;
    if (overflow === 'visible') return false;
    return axis === 'x'
      ? el.scrollWidth > el.clientWidth + 1
      : el.scrollHeight > el.clientHeight + 1;
  };

  const radiusOf = (el: Element): number => {
    const s = getComputedStyle(el);
    return Math.min(
      parseFloat(s.borderTopLeftRadius) || 0,
      parseFloat(s.borderTopRightRadius) || 0,
      parseFloat(s.borderBottomLeftRadius) || 0,
      parseFloat(s.borderBottomRightRadius) || 0,
    );
  };

  const all = [...scope.querySelectorAll('*')].filter(visible);

  // gutter — the shell's rail and the first box of the body beside it.
  const rail = scope.querySelector('.tm-rail');
  const body = scope.querySelector('.tm-app__body');
  if (rail && body && visible(rail)) {
    const r = rail.getBoundingClientRect();
    // Out-of-flow boxes (the compact header's "AI" and "?" orbs, fixed at the rail's foot) do not
    // sit beside the rail; the gutter is measured to the first box in the flow.
    const first = [...body.children].find(
      (c) => visible(c) && !['fixed', 'absolute'].includes(getComputedStyle(c).position),
    );
    if (first) {
      // The compact layout (Work area v2) starts with a full-height panel that adjoins the rail,
      // as the Figma draws it; there the gutter is the distance to that panel's first text.
      const compact = first.matches('[data-layout="compact"]');
      const firstText = compact
        ? [...first.querySelectorAll('*')].find((d) => visible(d) && ownTextRect(d))
        : undefined;
      const c = (firstText && ownTextRect(firstText)) ?? first.getBoundingClientRect();
      const rtl = getComputedStyle(body).direction === 'rtl';
      const gap = rtl ? r.left - c.right : c.left - r.right;
      // The gutter token changes with the Figma Layout mode (32 / 24 / 16); read the live value.
      const token = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--page-gutter'),
      );
      const required = Number.isFinite(token) ? token : options.gutter;
      if (gap < required - 0.5) {
        out.push({ rule: 'gutter', where: describe(first), measured: round(gap), required });
      }
    }
  }

  const interactive = (el: Element) =>
    el.matches(
      'button, a[href], [role="button"], [role="tab"], [role="link"], summary, select, input:not([type="hidden"])',
    );

  for (const el of all) {
    const box = el.getBoundingClientRect();

    // text-size — every element that paints its own text.
    const own = ownTextRect(el);
    if (own) {
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < options.minText - 0.05) {
        out.push({
          rule: 'text-size',
          where: describe(el),
          measured: round(size),
          required: options.minText,
        });
      }
    }

    // target-size — buttons and standalone links (a link inside running text is exempt, SC 2.5.8).
    if (interactive(el) && !el.closest('p, li > span, [data-inline-link]')) {
      const inputType = el instanceof HTMLInputElement ? el.type : '';
      const textual =
        el instanceof HTMLInputElement &&
        !['checkbox', 'radio', 'button', 'submit'].includes(inputType);
      if (!textual) {
        const small = Math.min(box.width, box.height);
        if (small < options.minTarget - 0.5) {
          out.push({
            rule: 'target-size',
            where: describe(el),
            measured: round(small),
            required: options.minTarget,
          });
        }
      }
    }

    if (!drawn(el)) continue;
    const text = textRect(el);
    if (!text) continue;
    const start = text.left - box.left;
    const end = box.right - text.right;
    const inset = Math.min(start, end);
    const radius = radiusOf(el);
    const capsule = radius >= box.height / 2 - 0.5;
    // A square glyph box up to 64px (an avatar's initials in a circle, a numbered pin, a round
    // icon) has no rounded *end* and no run of text: its glyph is centred, so the inset rules do
    // not apply; it is still measured as a target.
    if (Math.abs(box.width - box.height) <= 1 && box.width <= 64) continue;

    if (capsule) {
      // Rule 1: 16px and at least half the height from a rounded end; a tall capsule is held to
      // the 24px any container edge needs, not more (the curve has turned by then).
      const required = Math.max(
        options.capsuleInset,
        Math.min(box.height / 2, options.containerInset),
      );
      if (inset < required - 0.5) {
        out.push({
          rule: 'capsule-inset',
          where: describe(el),
          measured: round(inset),
          required: round(required),
        });
      }
      continue;
    }

    if (interactive(el) || el.matches('[class*="chip"], [class*="pill"], [class*="tag"]')) {
      if (inset < options.controlInset - 0.5) {
        out.push({
          rule: 'control-inset',
          where: describe(el),
          measured: round(inset),
          required: options.controlInset,
        });
      }
      continue;
    }

    const container =
      el.matches('dialog, [role="dialog"], [role="alertdialog"], section, article, aside') ||
      /(?:^|[-_])(card|panel|sheet|dialog|lens|context-rail)(?:$|[-_])/.test(
        el.className.toString(),
      );
    if (container && box.height >= 48) {
      const prose = textRect(el, true);
      if (!prose) continue;
      // Text scrolled past a scrolling panel's edge is not near that edge; that edge is the
      // scroll viewport. The padding of a scrolling axis is checked by the content's own boxes.
      const edges: [NonNullable<LayoutViolation['side']>, number][] = [
        ...(scrolls(el, 'x')
          ? []
          : ([
              ['left', prose.left - box.left],
              ['right', box.right - prose.right],
            ] as const)),
        ...(scrolls(el, 'y')
          ? []
          : ([
              ['top', prose.top - box.top],
              ['bottom', box.bottom - prose.bottom],
            ] as const)),
      ];
      if (edges.length === 0) continue;
      const [side, edge] = edges.reduce((a, b) => (b[1] < a[1] ? b : a));
      if (edge < options.containerInset - 0.5) {
        out.push({
          rule: 'container-inset',
          where: describe(el),
          measured: round(edge),
          required: options.containerInset,
          side,
        });
      }
    }
  }

  // label-cut — a primary-navigation label cut short. The ellipsis keeps the accessible name
  // whole (2.5.3), but the eye reads "M…": the destination has no visible name.
  for (const el of scope.querySelectorAll('.tm-rail *, .tm-mobile-nav *')) {
    if (!visible(el) || !ownTextRect(el)) continue;
    const s = getComputedStyle(el);
    // A label clamped to N lines (`line-clamp`) is cut when its text needs more lines.
    const clamped = s.webkitLineClamp !== 'none' && el.scrollHeight > el.clientHeight + 1;
    const ellipsis =
      s.textOverflow === 'ellipsis' &&
      s.overflowX !== 'visible' &&
      el.scrollWidth > el.clientWidth + 1;
    if (clamped || ellipsis) {
      out.push({
        rule: 'label-cut',
        where: describe(el),
        measured: round(el.clientWidth),
        required: round(el.scrollWidth),
      });
    }
  }

  // header-height — the page header row: one control height.
  for (const row of scope.querySelectorAll('.tm-canvas-header__actions')) {
    const controls = [...row.querySelectorAll('button, a[href], [role="button"]')].filter(
      (c) =>
        visible(c) &&
        c.closest('.tm-canvas-header__actions') === row &&
        !c.closest(
          '[role="menu"], [role="dialog"], [role="listbox"], [popover], [class*="__panel"]',
        ),
    );
    const heights = [...new Set(controls.map((c) => Math.round(c.getBoundingClientRect().height)))];
    if (heights.length > 1) {
      out.push({
        rule: 'header-height',
        where: describe(row),
        measured: heights.length,
        required: 1,
      });
    }
  }

  return out;
}

/** Violations counted per rule, the unit the baseline ratchets. */
export function countByRule(
  violations: readonly LayoutViolation[],
): Partial<Record<LayoutRule, number>> {
  const counts: Partial<Record<LayoutRule, number>> = {};
  for (const v of violations) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
  return counts;
}
