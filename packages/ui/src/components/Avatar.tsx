import type { OrbSize } from './OrbButton.js';

export type Audience = 'internal' | 'client';

export interface AvatarProps {
  /** The person's name. Used for the initials and for the accessible name. */
  name: string;
  src?: string;
  /**
   * `client` draws the violet external-boundary ring — and adds the word "client" to the
   * accessible name, because the ring is a colour and colour is never the only carrier.
   */
  audience?: Audience;
  size?: OrbSize;
  /**
   * Set when the name is already visible next to the avatar. The image then contributes
   * nothing to the accessibility tree instead of repeating the name.
   */
  decorative?: boolean;
  className?: string;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  // A single-word name gives its first two letters rather than one, so "Mostafa" reads as "MO"
  // not a lone "M" — the same rule the web People screens' `initialsOf` uses (ADM-19).
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? '';
  const last = parts[parts.length - 1]?.[0] ?? '';
  return (first + last).toUpperCase();
}

/**
 * How many distinct initials orbs can share before two look identical. ADM-19: two people whose
 * names both reduce to "MM" were drawn as the same ink disc, so a stack of people read as one
 * repeated avatar. A tint derived from the whole name gives same-initial people a different colour,
 * so colour disambiguates where the two letters cannot. The colour is decorative — initials and the
 * accessible name still carry the identity — so it is never the only signal.
 */
const AVATAR_TINTS = 6;

/** A stable index 0..AVATAR_TINTS-1 from the full name, so one person always keeps one colour. */
function tintIndex(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return hash % AVATAR_TINTS;
}

export function Avatar({
  name,
  src,
  audience = 'internal',
  size = 'default',
  decorative = false,
  className,
}: AvatarProps) {
  // Tint only the initials orbs. A client avatar keeps its violet boundary ring (a semantic colour,
  // not a per-person one), and an image avatar needs no tint — the photo is the distinguisher.
  const tinted = !src && audience !== 'client';

  const classes = [
    'tm-avatar',
    `tm-orb-button--${size}`,
    audience === 'client' ? 'tm-avatar--client' : null,
    tinted ? `tm-avatar--tint-${tintIndex(name)}` : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  const accessibleName = audience === 'client' ? `${name}, client` : name;

  return (
    <span
      className={classes}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : accessibleName}
      aria-hidden={decorative ? true : undefined}
    >
      {src ? (
        <img className="tm-avatar__image" src={src} alt="" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
}

export interface AvatarOverflowProps {
  /** How many people are not shown. */
  count: number;
  /** The full accessible sentence, e.g. "7 more people". */
  label: string;
  size?: OrbSize;
  className?: string;
}

/** The "+7" disc at the end of a stack. A count, not a person. */
export function AvatarOverflow({ count, label, size = 'default', className }: AvatarOverflowProps) {
  const classes = ['tm-avatar', 'tm-avatar--overflow', `tm-orb-button--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} role="img" aria-label={label}>
      <span aria-hidden="true">{`+${count}`}</span>
    </span>
  );
}
