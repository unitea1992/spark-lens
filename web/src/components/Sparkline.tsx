import { useEffect, useId, useState, type ReactNode } from "react";

const W = 300;
const H = 44;
const PAD = 3;

type Range = "live" | "day";

/** Minute averages for the last day, laid on a fixed 1440-slot axis so gaps show as gaps. */
function useDayHistory(key: string | undefined, active: boolean): (number | null)[] | null {
  const [values, setValues] = useState<(number | null)[] | null>(null);
  useEffect(() => {
    if (!key || !active) return;
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/history?key=${encodeURIComponent(key)}`);
        const points = (await res.json()) as { t: number; v: number }[];
        const nowMin = Math.floor(Date.now() / 60_000);
        const slots: (number | null)[] = Array.from({ length: 1440 }, () => null);
        for (const p of points) {
          const i = 1439 - (nowMin - Math.floor(p.t / 60_000));
          if (i >= 0 && i < 1440) slots[i] = p.v;
        }
        if (!stopped) setValues(slots);
      } catch {
        if (!stopped) setValues([]);
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [key, active]);
  return values;
}

/**
 * Trend line with a switch between the live last minutes and the last 24
 * hours (minute averages fetched on demand) when a history key is given.
 */
export function Sparkline(props: {
  values: (number | null)[];
  stepSec: number;
  max?: number;
  series: 1 | 2 | 3;
  label: string;
  format: (v: number) => string;
  /** Server history series, e.g. "host:spark-1:gpu". */
  historyKey?: string;
}) {
  const [range, setRange] = useState<Range>("live");
  const day = useDayHistory(props.historyKey, range === "day");
  const control = props.historyKey ? (
    <span className="spark__range" role="group" aria-label="期間">
      <button type="button" aria-pressed={range === "live"} onClick={() => setRange("live")}>
        直近
      </button>
      <button type="button" aria-pressed={range === "day"} onClick={() => setRange("day")}>
        24時間
      </button>
    </span>
  ) : null;
  if (range === "day") {
    return (
      <SparkPlot {...props} values={day ?? []} stepSec={60} control={control} emptyText={day ? "まだ記録がありません" : "読み込み中…"} />
    );
  }
  return <SparkPlot {...props} control={control} />;
}

function ago(seconds: number): string {
  if (seconds === 0) return "現在";
  if (seconds < 60) return `${seconds}秒前`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}分前`;
  return `${Math.floor(seconds / 3600)}時間${Math.round((seconds % 3600) / 60)}分前`;
}

function SparkPlot({
  values,
  stepSec,
  max,
  series,
  label,
  format,
  control,
  emptyText,
}: {
  values: (number | null)[];
  stepSec: number;
  /** Fixed top of the scale; omitted = fit to the data. */
  max?: number;
  /** Which series colour (1..3) to draw in. */
  series: 1 | 2 | 3;
  label: string;
  format: (v: number) => string;
  control?: ReactNode;
  emptyText?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();
  const n = values.length;
  const known = values.filter((v): v is number => v !== null);
  if (n < 2 || known.length < 2) {
    return (
      <div className="spark">
        <div className="spark__legend">
          <span>{label}</span>
          {control}
        </div>
        <div className="spark spark--empty">{emptyText ?? `${label}の推移を記録中…`}</div>
      </div>
    );
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
      <div className="spark__legend">
        <span>{label}</span>
        <span className="spark__readout">
          {hover === null
            ? control
              ? ""
              : `直近 ${Math.round((n * stepSec) / 60)} 分`
            : `${ago(secondsAgo)} ${hv === null || hv === undefined ? "記録なし" : format(hv)}`}
        </span>
        {control}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}の${stepSec >= 60 ? "24時間" : `直近${Math.round((n * stepSec) / 60)}分`}の推移。最新 ${format(last)}`}
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
    </div>
  );
}
