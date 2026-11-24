'use client';

import { useTOr } from '../../lib/i18n/use-t-or';
import './ai-badge.css';

/**
 * The AI mark (plan 60 v2 §4.10, Figma `Badge/AI` 947:1014): "AI" in the mono overline style in
 * an outlined capsule. It sits after an AI employee's name in People, pickers, comments, mentions,
 * activity and the Doers row. It is text plus an outline, so it reads without colour (WCAG 1.4.1),
 * and screen readers hear "AI employee" once, not the two letters.
 */
export function AiBadge({ className }: { className?: string }) {
  const tOr = useTOr();
  return (
    <span className={className ? `tm-ai-badge ${className}` : 'tm-ai-badge'}>
      <span aria-hidden="true">AI</span>
      <span className="tm-visually-hidden">{tOr('AiBadge.label', 'AI employee')}</span>
    </span>
  );
}

/**
 * An AI employee's avatar (Figma `Avatar/24 · AI`, `Avatar/40 · AI`): a rounded square with an
 * outline and the initials in the mono overline style, so it differs from a person's round face
 * by shape as well as by the badge beside the name. Decorative: the name and badge carry meaning.
 */
export function AiAvatar({
  initials,
  size = 24,
  className,
}: {
  initials: string;
  size?: 24 | 40;
  /** 60-08: a slot class of the place it sits in (a comment's face, a stacked face). */
  className?: string;
}) {
  return (
    <span
      className={className ? `tm-ai-avatar ${className}` : 'tm-ai-avatar'}
      data-size={size}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}

/**
 * 60-08: the letters in an AI employee's avatar, as the S7 designs draw them. A one-word Latin
 * name shows its first two letters ("Mat" → "MA", "Nour" → "NO"); any other name shows the first
 * letters of its first and last words, and an Arabic one-word name its first letter ("زياد" → "ز").
 */
export function aiInitialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  if (words.length === 1 && /^[A-Za-z]{2}/.test(first)) return first.slice(0, 2).toUpperCase();
  const last = words.length > 1 ? (words[words.length - 1] ?? '') : '';
  return (Array.from(first)[0] ?? '') + (Array.from(last)[0] ?? '') || '?';
}
