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
 */

export type LayoutRule =
  | 'gutter'
  | 'capsule-inset'
  | 'control-inset'
  | 'container-inset'
  | 'header-height'
  | 'text-size'
  | 'target-size';

export interface LayoutViolation {
  readonly rule: LayoutRule;
  /** A short, stable description of the element: tag and first class names. */
  readonly where: string;
  /** What was measured, in CSS px. */
  readonly measured: number;
  readonly required: number;
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

  /** The text box of an element: its own text, or the text of the one element that holds it. */
  const textRect = (el: Element): DOMRect | null => {
    const own = ownTextRect(el);
    if (own) return own;
    const holders = [...el.querySelectorAll('*')].filter((c) => visible(c) && ownTextRect(c));
    if (holders.length === 0) return null;
    const rects = holders.map((h) => ownTextRect(h) as DOMRect);
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const top = Math.min(...rects.map((r) => r.top));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return new DOMRect(left, top, right - left, bottom - top);
  };

  /** A box is drawn when it has a visible border or a background different from transparent. */
  const drawn = (el: Element): boolean => {
    const s = getComputedStyle(el);
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) =>
        parseFloat(s.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
        s.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none',
    );
    const bg = s.backgroundColor;
    const filled = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    return border || filled || s.backgroundImage !== 'none';
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
    const first = [...body.children].find((c) => visible(c));
    if (first) {
      const c = first.getBoundingClientRect();
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
      const top = text.top - box.top;
      const bottom = box.bottom - text.bottom;
      const edge = Math.min(start, end, top, bottom);
      if (edge < options.containerInset - 0.5) {
        out.push({
          rule: 'container-inset',
          where: describe(el),
          measured: round(edge),
          required: options.containerInset,
        });
      }
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
