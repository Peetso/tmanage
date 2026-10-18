/** Small presentation helpers shared by the Control Center screens. */

/** "Windows · Chrome" out of a user-agent string; the raw label when nothing is recognised. */
export function shortDevice(label: string | null): string {
  if (!label) return 'Unknown device';
  const os = /Windows/i.test(label)
    ? 'Windows'
    : /Android/i.test(label)
      ? 'Android'
      : /iPhone|iPad|iOS/i.test(label)
        ? 'iOS'
        : /Mac OS|Macintosh/i.test(label)
          ? 'macOS'
          : /Linux/i.test(label)
            ? 'Linux'
            : null;
  const browser = /Edg\//.test(label)
    ? 'Edge'
    : /Chrome\//.test(label)
      ? 'Chrome'
      : /Firefox\//.test(label)
        ? 'Firefox'
        : /Safari\//.test(label)
          ? 'Safari'
          : null;
  if (!os && !browser) return label.length > 40 ? `${label.slice(0, 40)}…` : label;
  return [os, browser].filter(Boolean).join(' · ');
}

/** ADM-08's "NOW · 12 MIN · 3H · 26H" column. */
export function sinceLabel(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
  if (minutes < 2) return 'Now';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)} days`;
}
