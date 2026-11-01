'use client';

import { useTOr } from '../../../lib/i18n/use-t-or';
import './pane.css';

/** The OpenStreetMap address of a point — a link only: no tiles, no key, nothing loaded. */
export function osmHref(lat: number, lng: number): string {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
}

/** R7 slice 4 — a `kind='location'` message: label, coordinates and an OpenStreetMap link. */
export function LocationBubble({ lat, lng, label }: { lat: number; lng: number; label: string }) {
  const tOr = useTOr();
  return (
    <span className="tm-pane-location">
      <strong>
        <span aria-hidden="true">📍 </span>
        {label === '' ? tOr('ChatMessages.location', 'Location') : label}
      </strong>
      <span className="tm-pane-location__coords" dir="ltr">
        {lat.toFixed(5)}, {lng.toFixed(5)}
      </span>
      <a href={osmHref(lat, lng)} target="_blank" rel="noopener noreferrer">
        {tOr('ChatMessages.openInMap', 'Open in OpenStreetMap')}
      </a>
    </span>
  );
}
