import { useState } from "react";
import type { ModelUsage as Row, UsageSnapshot } from "../../../server/types.ts";
import { count } from "../format.ts";

type Range = "today" | "week" | "month";

const LABELS: Record<Range, string> = { today: "今日", week: "7 日間", month: "30 日間" };

function breakdown(r: Row): string {
  if (r.input === null || r.output === null) return "内訳なし";
  const parts = [`入力 ${count(r.input)}`, `出力 ${count(r.output)}`];
  if (r.cached) parts.push(`キャッシュ読み取り ${count(r.cached)}`);
  return parts.join("・");
}

/** Token use per model across the local LLMs and the cloud tools. */
export function ModelUsage({ usage }: { usage: UsageSnapshot }) {
  const [range, setRange] = useState<Range>("today");
  const rows = usage[range];
  const top = rows[0]?.total ?? 0;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const local = rows.filter((r) => r.local).reduce((a, r) => a + r.total, 0);

  return (
    <div className="card usage">
      <div className="usage__head">
        <p className="usage__summary">
          {total === 0 ? (
            "まだ記録がありません。"
          ) : (
            <>
              合計 <strong>{count(total)}</strong> トークン
              {local > 0 ? `（うちローカル ${count(local)}）` : ""}
            </>
          )}
        </p>
        <div className="toggle" role="group" aria-label="期間">
          {(["today", "week", "month"] as Range[]).map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>
              {LABELS[r]}
            </button>
          ))}
        </div>
      </div>
      {rows.length > 0 && (
        <ul className="usage__rows">
          {rows.map((r) => (
            <li key={`${r.source}:${r.model}`}>
              <div className="usage__line">
                <span className="usage__model">{r.model}</span>
                <span className={`chip${r.local ? " chip--local" : ""}`}>{r.local ? "ローカル" : r.source}</span>
                <strong className="usage__total">{count(r.total)}</strong>
              </div>
              <div className="usage__bar" aria-hidden="true">
                <div className={r.local ? "usage__fill usage__fill--local" : "usage__fill"} style={{ width: `${top ? (r.total / top) * 100 : 0}%` }} />
              </div>
              <p className="usage__detail">{breakdown(r)}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="card__foot">各ツールがこのマシンに残している記録から集計しています。「キャッシュ読み取り」は、キャッシュから読み取った入力トークン数です。Claude Code は記録を約 30 日分しか残さないため、30 日間の古い日は不足している場合があります。</p>
    </div>
  );
}
