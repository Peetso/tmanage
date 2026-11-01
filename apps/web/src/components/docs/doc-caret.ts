/**
 * Where a character of a textarea sits, in pixels from the textarea's top-start corner — the "/"
 * menu opens under the line the slash was typed on (Figma 446:35321). The classic mirror trick: a
 * hidden div with the textarea's text metrics, filled up to the index, measured at a marker span.
 * Returns null where layout is not measurable (server render, jsdom).
 */
const COPIED = [
  'boxSizing',
  'width',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'letterSpacing',
  'wordSpacing',
  'direction',
] as const;

export function caretPoint(
  control: HTMLTextAreaElement,
  index: number,
): { readonly top: number; readonly left: number; readonly lineHeight: number } | null {
  if (typeof window === 'undefined' || control.clientWidth === 0) return null;
  const style = window.getComputedStyle(control);
  const mirror = document.createElement('div');
  const target = mirror.style as unknown as Record<string, string>;
  const source = style as unknown as Record<string, string>;
  for (const property of COPIED) target[property] = source[property] ?? '';
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.textContent = control.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = control.value.slice(index) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
  const point = {
    top: marker.offsetTop - control.scrollTop,
    left: marker.offsetLeft - control.scrollLeft,
    lineHeight,
  };
  document.body.removeChild(mirror);
  return point;
}
