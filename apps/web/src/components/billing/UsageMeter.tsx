import type { PlanUsageMeterView } from '../../lib/api/plan-usage';

/**
 * The Plan and usage meter (Figma F4): label and figure over a capsule bar that fills from the
 * inline start, so it fills from the right in Arabic. The bar has no motion. `valueText` is what
 * a screen reader hears for the bar when the figure alone would not say enough.
 */
export function UsageMeter({
  id,
  label,
  meter,
  value,
  valueText,
  note,
}: {
  id: string;
  label: string;
  meter: PlanUsageMeterView;
  value: string;
  valueText?: string;
  note?: string;
}) {
  const limit = meter.limit ?? 0;
  const percent = limit > 0 ? Math.min(100, Math.round((meter.used / limit) * 100)) : 0;
  const labelId = `tm-pu-meter-${id}`;
  return (
    <div className="tm-pu-meter" data-level={meter.level}>
      <div className="tm-pu-meter__row">
        <span id={labelId} className="tm-pu-meter__label">
          {label}
        </span>
        <span className="tm-pu-meter__value">{value}</span>
      </div>
      <div
        className="tm-pu-meter__track"
        role="progressbar"
        aria-labelledby={labelId}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(meter.used, limit)}
        aria-valuetext={valueText ?? value}
      >
        <div className="tm-pu-meter__fill" style={{ inlineSize: `${percent}%` }} />
      </div>
      {note === undefined ? null : <p className="tm-pu-meter__note">{note}</p>}
    </div>
  );
}
