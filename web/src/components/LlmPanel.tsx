import type { HostSnapshot, LlmSnapshot } from "../../../server/types.ts";
import { count, duration, pct, shortHost } from "../format.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { Sparkline } from "./Sparkline.tsx";
import { StatusPill, type Tone } from "./StatusPill.tsx";

function status(llm: LlmSnapshot): { tone: Tone; text: string } {
  if (llm.state === "down") return { tone: "quiet", text: "停止中" };
  if (llm.state === "starting") return { tone: "warn", text: "起動中" };
  return (llm.requestsRunning ?? 0) > 0 ? { tone: "busy", text: "推論中" } : { tone: "good", text: "待機中" };
}

export function LlmPanel({ llm, hosts, now }: { llm: LlmSnapshot; hosts: HostSnapshot[]; now: number }) {
  const st = status(llm);
  const up = llm.state === "up";
  const busy = (llm.requestsRunning ?? 0) > 0;
  const kv = llm.kvCacheUsage === null ? null : llm.kvCacheUsage * 100;
  const nodes = llm.nodes.map((id) => hosts.find((h) => h.id === id)).filter((h): h is HostSnapshot => Boolean(h));

  return (
    <article className="card llm">
      <header className="card__head">
        <div>
          <h3 className="card__title">{llm.label}</h3>
          <p className="card__sub">
            {llm.models[0] ?? "モデル名は起動後に表示されます"}
            {llm.contextLength ? `・最大 ${count(llm.contextLength)} トークン` : ""}
          </p>
        </div>
        <StatusPill tone={st.tone}>{st.text}</StatusPill>
      </header>

      {!up && (
        <p className={`notice ${llm.state === "starting" ? "notice--warn" : ""}`}>
          {llm.state === "starting"
            ? "モデルを読み込んでいます。完了すると自動で「待機中」に変わります。"
            : "API に接続できません。モデルは起動していません。"}
          {llm.detail ? <span className="notice__detail">{llm.detail}</span> : null}
        </p>
      )}

      <div className={`llm__cols${up ? "" : " llm__cols--down"}`}>
        {up && (
        <div className="llm__col">
      <div className="llm__headline">
        <div className="bignum">
          <span className="bignum__value">
            {up && llm.genTokensPerSec !== null ? (busy || llm.genTokensPerSec > 0 ? llm.genTokensPerSec.toFixed(1) : "0") : "–"}
          </span>
          <span className="bignum__unit">トークン/秒</span>
        </div>
        <dl className="pairs">
          <div>
            <dt>処理中</dt>
            <dd>{llm.requestsRunning ?? "–"}</dd>
          </div>
          <div>
            <dt>順番待ち</dt>
            <dd>{llm.requestsWaiting ?? "–"}</dd>
          </div>
          <div>
            <dt>最初の応答まで</dt>
            <dd>{llm.ttftSec === null ? "–" : `${llm.ttftSec.toFixed(2)} 秒`}</dd>
          </div>
        </dl>
      </div>

      <Sparkline
        values={llm.history.genTps}
        stepSec={llm.history.stepSec}
        series={1}
        label="生成速度"
        format={(v) => `${v.toFixed(1)} トークン/秒`}
      />

      <div className="stat">
        <div className="stat__line">
          <span>会話メモリ（KV キャッシュ）</span>
          <span>
            <strong>{pct(kv, 1)}</strong>
          </span>
        </div>
        <Meter value={kv} level={levelFor(kv, 85, 95)} label="KV キャッシュ使用率" />
      </div>
        </div>
        )}
        <div className="llm__col">
      <dl className="facts facts--wide">
        <div>
          <dt>今日のトークン</dt>
          <dd>
            入力 {count(llm.tokensToday.prompt)}・出力 {count(llm.tokensToday.generation)}
          </dd>
        </div>
        <div>
          <dt>起動からの累計</dt>
          <dd>
            {llm.tokensTotal ? `入力 ${count(llm.tokensTotal.prompt)}・出力 ${count(llm.tokensTotal.generation)}` : "–"}
          </dd>
        </div>
        <div>
          <dt>キャッシュ再利用率</dt>
          <dd>{llm.prefixCacheHitRate === null ? "–" : pct(llm.prefixCacheHitRate * 100)}</dd>
        </div>
        <div>
          <dt>先読みの採用率</dt>
          <dd>{llm.draftAcceptRate === null ? "–" : pct(llm.draftAcceptRate * 100)}</dd>
        </div>
        <div>
          <dt>稼働確認</dt>
          <dd>{llm.upSince ? `${duration((now - llm.upSince) / 1000)}前から連続` : "–"}</dd>
        </div>
        <div>
          <dt>API</dt>
          <dd>
            {shortHost(llm.baseUrl)}/v1{llm.latencyMs !== null ? `・${llm.latencyMs} ms` : ""}
          </dd>
        </div>
      </dl>

      {nodes.length > 0 && (
        <ul className="nodes">
          {nodes.map((h) => {
            const container = llm.containers.find((c) => c.host === h.id);
            return (
              <li key={h.id}>
                <span className="nodes__name">{h.label}</span>
                <span className="nodes__meta">
                  {container ? container.status : h.online ? "コンテナなし" : "応答なし"}
                </span>
                <span className="nodes__value">GPU {pct(h.gpu?.utilPct)}</span>
              </li>
            );
          })}
        </ul>
      )}
        </div>
      </div>
    </article>
  );
}
