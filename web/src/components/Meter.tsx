export type Level = "normal" | "warn" | "critical";

export function levelFor(value: number | null, warnAt: number, criticalAt: number): Level {
  if (value === null) return "normal";
  return value >= criticalAt ? "critical" : value >= warnAt ? "warn" : "normal";
}

/**
 * A thin horizontal bar. `marker` draws a tick at another position on the
 * same scale (used for "where even pacing would be").
 */
export function Meter({
  value,
  level = "normal",
  marker,
  markerLabel,
  projection,
  label,
}: {
  value: number | null;
  level?: Level;
  marker?: number | null;
  markerLabel?: string;
  /** Where the value is heading, drawn as a faint extension of the fill. */
  projection?: number | null;
  label: string;
}) {
  const width = value === null ? 0 : Math.min(100, Math.max(0, value));
  const ghost = projection === null || projection === undefined ? null : Math.min(100, Math.max(width, projection));
  const over = (projection ?? 0) > 100;
  return (
    <div
      className={`meter meter--${level}${over ? " meter--over" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(width)}
      aria-valuetext={value === null ? "不明" : `${Math.round(width)}%`}
    >
      {ghost !== null && ghost > width && (
        <div className="meter__ghost" style={{ left: `${width}%`, width: `${ghost - width}%` }} />
      )}
      <div className="meter__fill" style={{ width: `${width}%` }} />
      {marker !== null && marker !== undefined && (
        <div className="meter__marker" style={{ left: `${Math.min(100, Math.max(0, marker))}%` }} title={markerLabel} />
      )}
    </div>
  );
}
