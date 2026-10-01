import type { HostSnapshot } from "../../../server/types.ts";

const GiB = 1024 ** 3;

interface Part {
  key: string;
  label: string;
  gib: number;
}

/**
 * One machine's memory as a field of 1 GiB tiles: what the model's weights
 * hold, the KV cache it reserved (and how much of it is in use), the rest of
 * the serving process, everything else, and what is free.
 */
export function MemoryMap({
  host,
  weightsGiB,
  kvGiB,
  kvUsage,
}: {
  host: HostSnapshot;
  weightsGiB: number | null;
  kvGiB: number | null;
  kvUsage: number | null;
}) {
  if (!host.memTotalBytes || host.memUsedBytes === null) return null;
  const total = host.memTotalBytes / GiB;
  const used = host.memUsedBytes / GiB;
  const process = host.gpuProcesses.reduce((a, p) => a + (p.memBytes ?? 0), 0) / GiB;
  const weights = weightsGiB ?? 0;
  const kv = kvGiB ?? 0;
  const kvUsed = kv * Math.min(1, Math.max(0, kvUsage ?? 0));
  const parts: Part[] = [
    { key: "weights", label: "モデルの重み", gib: weights },
    { key: "kv-used", label: "KV キャッシュ（使用中）", gib: kvUsed },
    { key: "kv-free", label: "KV キャッシュ（確保済み・空き）", gib: kv - kvUsed },
    { key: "runtime", label: "推論サーバーのその他", gib: Math.max(0, process - weights - kv) },
    { key: "system", label: "OS・ほかのプロセス", gib: Math.max(0, used - Math.max(process, weights + kv)) },
    { key: "free", label: "空き", gib: Math.max(0, total - used) },
  ];
  // Round each part to whole tiles while keeping the total exact.
  const target = Math.round(total);
  const counts = parts.map((p) => Math.floor(p.gib));
  const byRemainder = parts.map((p, i) => [p.gib - Math.floor(p.gib), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; counts.reduce((a, b) => a + b, 0) < target && k < byRemainder.length; k++) counts[byRemainder[k]![1]]! += 1;
  const tiles = parts.flatMap((p, i) => Array.from({ length: counts[i]! }, () => p.key));

  return (
    <figure className="memmap">
      <figcaption className="memmap__title">
        メモリの内訳<span>{host.label}・1 マス = 1 GiB</span>
      </figcaption>
      <div className="memmap__grid" role="img" aria-label={parts.map((p) => `${p.label} ${p.gib.toFixed(1)} GiB`).join("、")}>
        {tiles.map((k, i) => (
          <i key={i} className={`memmap__tile memmap__tile--${k}`} />
        ))}
      </div>
      <ul className="memmap__legend">
        {parts
          .filter((p) => p.gib >= 0.05 || p.key === "kv-used")
          .map((p) => (
            <li key={p.key}>
              <i className={`memmap__tile memmap__tile--${p.key}`} />
              {p.label}
              <strong>{p.gib.toFixed(p.gib < 10 ? 1 : 0)} GiB</strong>
            </li>
          ))}
      </ul>
    </figure>
  );
}
