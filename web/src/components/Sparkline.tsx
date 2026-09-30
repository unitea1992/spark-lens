import { useId, useState } from "react";

const W = 300;
const H = 44;
const PAD = 3;

/**
 * Compact trend line for the last few minutes. Gaps (null) break the line.
 * Hovering or touching shows the value under the pointer.
 */
export function Sparkline({
  values,
  stepSec,
  max,
  series,
  label,
  format,
}: {
  values: (number | null)[];
  stepSec: number;
  /** Fixed top of the scale; omitted = fit to the data. */
  max?: number;
  /** Which series colour (1..3) to draw in. */
  series: 1 | 2 | 3;
  label: string;
  format: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();
  const n = values.length;
  const known = values.filter((v): v is number => v !== null);
  if (n < 2 || known.length < 2) {
    return <div className="spark spark--empty">{label}の推移を記録中…</div>;
  }
  const top = max ?? Math.max(1, ...known) * 1.15;
  const x = (i: number) => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (Math.min(v, top) / top) * (H - 2 * PAD);

  // One path segment per run of consecutive samples.
  const lines: string[] = [];
  const areas: string[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length > 1) {
      const pts = run.map((i) => `${x(i).toFixed(1)},${y(values[i]!).toFixed(1)}`);
      lines.push(`M${pts.join("L")}`);
      areas.push(`M${x(run[0]!).toFixed(1)},${H - PAD}L${pts.join("L")}L${x(run[run.length - 1]!).toFixed(1)},${H - PAD}Z`);
    }
    run = [];
  };
  values.forEach((v, i) => (v === null ? flush() : run.push(i)));
  flush();

  const onMove = (clientX: number, target: Element) => {
    const box = target.getBoundingClientRect();
    const i = Math.round(((clientX - box.left) / box.width) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };
  const hv = hover === null ? null : values[hover];
  const secondsAgo = hover === null ? 0 : (n - 1 - hover) * stepSec;
  const last = known[known.length - 1]!;

  return (
    <div className={`spark series-text-${series}`}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}の直近${Math.round((n * stepSec) / 60)}分の推移。現在 ${format(last)}`}
        onPointerMove={(e) => onMove(e.clientX, e.currentTarget)}
        onPointerDown={(e) => onMove(e.clientX, e.currentTarget)}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className={`spark__stop series-${series}`} stopOpacity="0.22" />
            <stop offset="1" className={`spark__stop series-${series}`} stopOpacity="0" />
          </linearGradient>
        </defs>
        {areas.map((d, i) => (
          <path key={`a${i}`} d={d} fill={`url(#${gradient})`} />
        ))}
        {lines.map((d, i) => (
          <path key={`l${i}`} d={d} className={`spark__line series-${series}`} vectorEffect="non-scaling-stroke" />
        ))}
        {hover !== null && (
          <line className="spark__cursor" x1={x(hover)} x2={x(hover)} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="spark__legend">
        <span>{label}</span>
        <span className="spark__readout">
          {hover === null
            ? `直近 ${Math.round((n * stepSec) / 60)} 分`
            : `${secondsAgo === 0 ? "現在" : secondsAgo < 60 ? `${secondsAgo}秒前` : `${Math.round(secondsAgo / 60)}分前`} ${hv === null || hv === undefined ? "記録なし" : format(hv)}`}
        </span>
      </div>
    </div>
  );
}
