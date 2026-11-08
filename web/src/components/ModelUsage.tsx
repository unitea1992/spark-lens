import { useState } from "react";
import type { ModelUsage as Row, UsageSnapshot } from "../../../server/types.ts";
import { count } from "../format.ts";

type Range = "today" | "week" | "month";

const LABELS: Record<Range, string> = { today: "今日", week: "7 日間", month: "30 日間" };

function breakdown(r: Row): string {
  if (r.input === null || r.output === null) return "内訳なし";
  // Cache writes are part of the input; shown apart, a jump in them marks a cache that expired.
  const input = r.cacheWrite ? `入力 ${count(r.input)}（うちキャッシュ書き込み ${count(r.cacheWrite)}）` : `入力 ${count(r.input)}`;
  const parts = [input, `出力 ${count(r.output)}`];
  if (r.cached) parts.push(`キャッシュ読み取り ${count(r.cached)}`);
  return parts.join(" / ");
}

function usd(n: number): string {
  if (n === 0) return "$0";
  if (n > 0 && n < 0.01) return "$0.01 未満";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(n: number): string {
  const pct = Math.max(0, Math.min(100, n));
  return pct > 0 && pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : String(Math.round(pct));
}

function price(r: Row): { text: string; unknown: boolean } {
  if (r.usd === null) return { text: r.local ? "API換算不可" : "料金不明", unknown: true };
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
  const localPriced = rows.filter((r) => r.local && r.usd !== null);
  const localUnpriced = rows.some((r) => r.local && r.usd === null);
  const checkedAt = usage.pricesCheckedAt ?? usage.pricesFetchedAt;
  const checked = checkedAt ? new Date(checkedAt).toLocaleString("ja-JP") : null;
  const priceStale = checkedAt === null || checkedAt === undefined || Date.now() - checkedAt > 6 * 3600_000;
  const measuredLocal = rows.filter((r) => r.local && r.cacheCoverage !== undefined);
  const cachePartial = measuredLocal.some((r) => r.cacheCoverage! < 0.999);
  const localPrompt = measuredLocal.reduce((a, r) => a + (r.input ?? 0) + (r.cached ?? 0), 0);
  const measuredPrompt = measuredLocal.reduce((a, r) => a + ((r.input ?? 0) + (r.cached ?? 0)) * (r.cacheCoverage ?? 0), 0);
  const cacheCoverage = localPrompt > 0 ? measuredPrompt / localPrompt * 100 : null;

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
                  {" / "}API 換算 <strong className="usage__usd">約 {usd(sum(rows))}</strong>
                </>
              )}
              {local > 0 && <span className="usage__local-saving">
                {" / "}ローカル節約相当 <strong className="usage__usd">{localPriced.length ? `約 ${usd(sum(localPriced))}` : "換算不可"}</strong>
                {localUnpriced ? "（未換算のモデルあり）" : ""}
                {cachePartial ? "（キャッシュ内訳は一部未記録）" : ""}
              </span>}
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
                <span className={`usage__price${price(r).unknown ? " usage__price--unknown" : ""}`}
                  title={r.priceReference ? `比較価格: ${r.priceReference}${r.priceComparison === "proxy" ? "（改変モデルのため元モデルで参考換算）" : ""}` : undefined}>
                  {price(r).text}{r.priceComparison === "proxy" ? " *" : ""}
                </span>
              </div>
              <div className="usage__bar" aria-hidden="true">
                <div className={r.local ? "usage__fill usage__fill--local" : "usage__fill"} style={{ width: `${top ? (r.total / top) * 100 : 0}%` }} />
              </div>
              <p className="usage__detail">{breakdown(r)}
                {r.local && r.priceReference ? ` / 比較先 ${r.priceReference}${r.priceComparison === "proxy" ? "（元モデル参考）" : ""}` : ""}
                {r.local && r.cacheCoverage !== undefined ? ` / キャッシュ実測カバー ${percent(r.cacheCoverage * 100)}%` : ""}
              </p>
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
            金額について<span>models.dev{checked ? ` / 最終確認 ${checked}${priceStale ? "（再確認待ち）" : ""}` : " / 未取得"}</span>
          </h4>
          <ul>
            <li>API 換算は実際の請求額ではありません。「ローカル節約相当」は同じ量を公開 API の比較料金で処理した場合の参考額です。</li>
            <li>ローカルモデルは明示した提供元の API 料金を参照し、未検閲版（*）は元モデルの料金による参考換算です。</li>
            <li>比較できないモデルは「API換算不可」とし、$0 とみなしません。</li>
            <li>現在の推論エンジンが公開するキャッシュ済み入力トークンは、比較先APIのキャッシュ読み取り単価で換算します。API側で同じヒットが成立する保証はありません。</li>
            <li>履歴のキャッシュ数は記録開始以降しか分かりません。未実測分は通常入力として計算するため高めに出る場合があります{cacheCoverage !== null ? `（この期間の入力キャッシュ実測カバー ${percent(cacheCoverage)}%）` : ""}。</li>
            <li>キャッシュ読み取り単価が公開されていない提供元は通常入力単価で計算します。時間帯割引・バッチ料金は未反映です。</li>
            <li>公開料金は無料のmodels.devを6時間ごとに確認し、変更がなければHTTPキャッシュを再利用します。通信に失敗しても直近の正常な単価を維持し、最終確認日時を表示します。</li>
            <li>電気代・ハードウェア代などローカル運用費は差し引いていません。</li>
            <li>料金が分からないクラウドのモデルは「料金不明」とし、合計に含めません。</li>
            <li>キャッシュ書き込みは入力として数えているため、全体として概算です。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
