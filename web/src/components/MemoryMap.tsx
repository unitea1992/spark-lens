import type { HostSnapshot } from "../../../server/types.ts";

const GiB = 1024 ** 3;

interface Part {
  key: string;
  label: string;
  gib: number;
}

/**
 * One machine's memory as a single band with a notch every GiB: the model's
 * weights, its KV cache (in use, then reserved but empty), everything else,
 * and what is free. Without the model's own figures (an engine whose start-up
 * lines are not known), it falls back to used / free.
 */
export function MemoryMap({
  host,
  weightsGiB,
  kvGiB,
  kvUsage,
  continued = false,
}: {
  /** A further machine of the same model: the heading is already above. */
  continued?: boolean;
  host: HostSnapshot;
  weightsGiB: number | null;
  kvGiB: number | null;
  kvUsage: number | null;
}) {
  if (!host.memTotalBytes || host.memUsedBytes === null) return null;
  const total = host.memTotalBytes / GiB;
  const used = host.memUsedBytes / GiB;
  const known = weightsGiB !== null && kvGiB !== null;
  const weights = weightsGiB ?? 0;
  const kv = kvGiB ?? 0;
  const kvUsed = kv * Math.min(1, Math.max(0, kvUsage ?? 0));
  const parts: Part[] = known
    ? [
        { key: "weights", label: "重み", gib: weights },
        { key: "kv-used", label: "KV 使用中", gib: kvUsed },
        { key: "kv-free", label: "KV 確保済み", gib: kv - kvUsed },
        { key: "other", label: "そのほか", gib: Math.max(0, used - weights - kv) },
        { key: "free", label: "空き", gib: Math.max(0, total - used) },
      ]
    : [
        { key: "other", label: "使用中", gib: used },
        { key: "free", label: "空き", gib: Math.max(0, total - used) },
      ];

  return (
    <figure className="memband">
      <figcaption className="memband__title">
        {continued ? null : "メモリの内訳"}
        <span className={continued ? "memband__more" : undefined}>
          {host.label}・{total.toFixed(0)} GiB{continued ? "" : "・目盛りは 1 GiB"}
        </span>
      </figcaption>
      <div
        className="memband__bar"
        role="img"
        aria-label={parts.map((p) => `${p.label} ${p.gib.toFixed(1)} GiB`).join("、")}
        style={{ ["--notch" as string]: `${100 / total}%` }}
      >
        {parts.map((p) => (
          <span key={p.key} className={`memband__seg memband__seg--${p.key}`} style={{ width: `${(p.gib / total) * 100}%` }} />
        ))}
      </div>
      <ul className="memband__legend">
        {parts.map((p) => (
          <li key={p.key}>
            <i className={`memband__key memband__seg--${p.key}`} />
            {p.label}
            <strong>{p.gib.toFixed(p.gib < 10 ? 1 : 0)}</strong>
            <span>GiB</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
