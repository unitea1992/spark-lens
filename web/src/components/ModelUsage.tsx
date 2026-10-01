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

function usd(n: number): string {
  if (n >= 100) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return n > 0 && n < 0.01 ? "$0.01 未満" : `$${n.toFixed(2)}`;
}

function price(r: Row): { text: string; unknown: boolean } {
  if (r.usd === null) return { text: "料金不明", unknown: true };
  if (r.usd === 0) return { text: "無料", unknown: false };
  return { text: `${r.usdEstimate ? "約 " : ""}${usd(r.usd)}`, unknown: false };
}

/** Token use per model across the local LLMs and the cloud tools. */
export function ModelUsage({ usage }: { usage: UsageSnapshot }) {
  const [range, setRange] = useState<Range>("today");
  const rows = usage[range];
  const top = rows[0]?.total ?? 0;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const local = rows.filter((r) => r.local).reduce((a, r) => a + r.total, 0);
  const sum = (list: Row[]) => list.reduce((a, r) => a + (r.usd ?? 0), 0);
  const priced = rows.some((r) => r.usd !== null);
  const unpriced = rows.filter((r) => r.usd === null).length;
  const fetched = usage.pricesFetchedAt ? new Date(usage.pricesFetchedAt).toLocaleDateString("ja-JP") : null;

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
              {priced && (
                <>
                  {" ・ "}API 換算 <strong className="usage__usd">{usd(sum(rows))}</strong>
                  {local > 0 ? `（うちローカル ${usd(sum(rows.filter((r) => r.local)))}）` : ""}
                  {unpriced > 0 ? `・料金不明 ${unpriced} 件を除く` : ""}
                </>
              )}
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
                <span className={`usage__price${price(r).unknown ? " usage__price--unknown" : ""}`}>{price(r).text}</span>
              </div>
              <div className="usage__bar" aria-hidden="true">
                <div className={r.local ? "usage__fill usage__fill--local" : "usage__fill"} style={{ width: `${top ? (r.total / top) * 100 : 0}%` }} />
              </div>
              <p className="usage__detail">{breakdown(r)}</p>
            </li>
          ))}
        </ul>
      )}
      <div className="usage__notes">
        <div className="usage__note">
          <h4>集計について</h4>
          <ul>
            <li>各ツールがこのマシンに残している記録から集計しています。</li>
            <li>「キャッシュ読み取り」は、キャッシュから読み取った入力トークン数です。</li>
            <li>Claude Code の記録は約 30 日分のため、30 日間の古い日は不足することがあります。</li>
          </ul>
        </div>
        <div className="usage__note">
          <h4>
            金額について<span>models.dev{fetched ? `・${fetched}取得` : "・未取得"}</span>
          </h4>
          <ul>
            <li>同じトークン数を API 料金で使った場合の目安です。</li>
            <li>ローカルモデルは同じモデルの API 料金で換算し、料金がないものは「料金不明」とします。</li>
            <li>Codex は合計しか分からないため、入力料金で計算した上限（「約」）です。</li>
            <li>キャッシュ書き込みは入力として数えているため、全体として概算です。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
