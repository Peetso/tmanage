import './pane.css';

/** R7 slice 4 — the day divider between two messages of different days. */
export function DateSeparator({ label }: { label: string }) {
  return (
    <li className="tm-pane-day">
      <span>{label}</span>
    </li>
  );
}
