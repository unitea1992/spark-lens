export interface Ring {
  key: string;
  label: string;
  /** 0..100, or null when unknown. */
  value: number | null;
}

const SIZE = 168;
const STROKE = 10;
const GAP = 5;
const OUTER = SIZE / 2 - STROKE / 2 - 1;

/**
 * Concentric load rings around one centre reading, like elements of a lens
 * seen head-on. Outer to inner follows the order of `rings`.
 */
export function LensDial({
  rings,
  center,
  unit,
  caption,
  dimmed,
}: {
  rings: Ring[];
  center: string;
  unit: string;
  caption: string;
  dimmed?: boolean;
}) {
  const summary = rings.map((r) => `${r.label} ${r.value === null ? "不明" : `${Math.round(r.value)}%`}`).join("、");
  return (
    <div className={`dial${dimmed ? " dial--dimmed" : ""}`}>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${caption} ${center}${unit}。${summary}`}>
        {rings.map((ring, i) => {
          const r = OUTER - i * (STROKE + GAP);
          const circumference = 2 * Math.PI * r;
          const share = ring.value === null ? 0 : Math.min(100, Math.max(0, ring.value)) / 100;
          // Keep a sliver visible at 0% so an idle ring still reads as "this ring, at rest".
          const length = ring.value === null ? 0 : Math.max(share * circumference, 0.5);
          return (
            <g key={ring.key} transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
              <circle className="dial__track" cx={SIZE / 2} cy={SIZE / 2} r={r} strokeWidth={STROKE} />
              <circle
                className={`dial__arc series-${i + 1}`}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={r}
                strokeWidth={STROKE}
                strokeDasharray={`${length} ${circumference}`}
              />
            </g>
          );
        })}
      </svg>
      <div className="dial__center" aria-hidden="true">
        <span className="dial__value">
          {center}
          <span className="dial__unit">{unit}</span>
        </span>
        <span className="dial__caption">{caption}</span>
      </div>
    </div>
  );
}
