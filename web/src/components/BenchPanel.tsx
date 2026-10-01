import { useState } from "react";
import type { BenchCase, BenchRun, BenchState } from "../../../server/types.ts";
import { shortDate } from "../format.ts";

type Key = BenchCase["key"];

const COLUMNS: { key: Key; label: string; unit: string; pick: (c: BenchCase) => number | null; better: "low" | "high" }[] = [
  { key: "ttft", label: "TTFT", unit: "秒", pick: (c) => (c.ttftMs === null ? null : c.ttftMs / 1000), better: "low" },
  { key: "prose", label: "生成速度（文章）", unit: "トークン/秒", pick: (c) => c.decodeTps, better: "high" },
  { key: "code", label: "生成速度（コード）", unit: "トークン/秒", pick: (c) => c.decodeTps, better: "high" },
  { key: "prefill", label: "プリフィル", unit: "トークン/秒", pick: (c) => c.prefillTps, better: "high" },
];

function value(run: BenchRun | undefined, key: Key): number | null {
  const c = run?.cases.find((x) => x.key === key);
  const col = COLUMNS.find((x) => x.key === key)!;
  return c ? col.pick(c) : null;
}

function fmt(v: number | null, key: Key): string {
  if (v === null) return "–";
  if (key === "ttft") return v.toFixed(2);
  return v >= 100 ? Math.round(v).toLocaleString("ja-JP") : v.toFixed(1);
}

/** Change against the newest run made on a different upstream version. */
function delta(now: number | null, before: number | null, better: "low" | "high"): { text: string; good: boolean } | null {
  if (now === null || before === null || before === 0) return null;
  const pct = ((now - before) / before) * 100;
  if (Math.abs(pct) < 2) return { text: "±0%", good: true };
  return { text: `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`, good: better === "high" ? pct > 0 : pct < 0 };
}

export function BenchPanel({ llmId, state }: { llmId: string; state: BenchState | undefined }) {
  const [notice, setNotice] = useState<string | null>(null);
  const runs = state?.runs ?? [];
  const latest = runs.find((r) => !r.error) ?? runs[0];
  const previousVersion =
    latest?.commit ? runs.find((r) => !r.error && r.commit !== null && r.commit !== latest.commit) : undefined;

  const start = async () => {
    try {
      const res = await fetch(`/api/llms/${llmId}/bench`, { method: "POST", headers: { "X-Spark-Lens": "1" } });
      setNotice(((await res.json()) as { message?: string }).message ?? null);
    } catch {
      setNotice("サーバーに接続できませんでした");
    }
  };

  return (
    <section className="bench" aria-label="ベンチマーク">
      <div className="bench__head">
        <h4>ベンチマーク</h4>
        {state?.running ? (
          <span className="bench__running">
            {state.stage}を計測中（{Math.min(state.done + 1, state.total)}/{state.total}）
          </span>
        ) : (
          <button type="button" className="link-button" onClick={() => void start()}>
            計測する（1〜2 分）
          </button>
        )}
      </div>
      {notice && !state?.running && <p className="bench__notice">{notice}</p>}
      {latest ? (
        <>
          <dl className="bench__figures">
            {COLUMNS.map((c) => {
              const v = value(latest, c.key);
              const d = previousVersion ? delta(v, value(previousVersion, c.key), c.better) : null;
              return (
                <div key={c.key}>
                  <dt>{c.label}</dt>
                  <dd>
                    {fmt(v, c.key)}
                    <small>{c.unit}</small>
                    {d && <em className={d.good ? "bench__up" : "bench__down"}>{d.text}</em>}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="bench__meta">
            {shortDate(latest.at)} に計測・{latest.repo ? `${latest.repo} ` : ""}
            {latest.commit ?? "版不明"}
            {previousVersion ? `・比較は前の版 ${previousVersion.commit ?? ""}（${shortDate(previousVersion.at)}）` : ""}
            {latest.error ? `・${latest.error}` : ""}
          </p>
          {runs.length > 1 && (
            <table className="bench__history">
              <thead>
                <tr>
                  <th>計測日時</th>
                  <th>版</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 6).map((r) => (
                  <tr key={r.id}>
                    <td>{shortDate(r.at)}</td>
                    <td>{r.commit ?? "–"}</td>
                    {COLUMNS.map((c) => (
                      <td key={c.key}>{r.error && value(r, c.key) === null ? "失敗" : fmt(value(r, c.key), c.key)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <p className="bench__notice">
          まだ計測していません。upstream を更新したら計測しておくと、版ごとの速さを比べられます。
        </p>
      )}
    </section>
  );
}
