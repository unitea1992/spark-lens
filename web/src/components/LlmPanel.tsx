import type { HostSnapshot, LlmSnapshot, RecipeSnapshot } from "../../../server/types.ts";
import { ago, count, dockerStatus, duration, pct, shortHost } from "../format.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { llmStatus } from "../status.ts";
import { RecipeControls } from "./RecipeCard.tsx";
import { Sparkline } from "./Sparkline.tsx";
import { StatusPill } from "./StatusPill.tsx";

function rate(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : v.toFixed(1);
}

export function LlmPanel({
  llm,
  hosts,
  recipes,
  now,
}: {
  llm: LlmSnapshot;
  hosts: HostSnapshot[];
  recipes: RecipeSnapshot[];
  now: number;
}) {
  const st = llmStatus(llm);
  const up = llm.state === "up";
  const running = (llm.requestsRunning ?? 0) > 0;
  const kv = llm.kvCacheUsage === null ? null : llm.kvCacheUsage * 100;
  const nodes = llm.nodes.map((id) => hosts.find((h) => h.id === id)).filter((h): h is HostSnapshot => Boolean(h));
  const spec = llm.spec;
  const sub = [llm.models[0], llm.engine, llm.contextLength ? `コンテキスト長 ${count(llm.contextLength)}` : null].filter(Boolean);

  return (
    <article className="card llm">
      <header className="card__head">
        <div>
          <h3 className="card__title">{llm.label}</h3>
          <p className="card__sub">{sub.length > 0 ? sub.join("・") : "モデル名は起動後に表示されます"}</p>
        </div>
        <StatusPill tone={st.tone}>{st.text}</StatusPill>
      </header>

      {recipes.map((r) => (
        <RecipeControls key={r.id} recipe={r} now={now} showName={recipes.length > 1} />
      ))}

      {(!up || llm.detail) && (
        <p className={`notice ${llm.state === "starting" || llm.detail ? "notice--warn" : ""}`}>
          {llm.state === "starting"
            ? "モデルを読み込んでいます。完了すると表示が自動で切り替わります。"
            : llm.state === "down"
              ? "モデルは起動していません。"
              : null}
          {llm.detail ? <span className="notice__detail">{llm.detail}</span> : null}
        </p>
      )}

      <div className={`llm__cols${up ? "" : " llm__cols--down"}`}>
        {up && (
          <div className="llm__col">
            <div className="llm__headline">
              {running ? (
                <div className="bignum">
                  <span className="bignum__value">{rate(llm.genTokensPerSec)}</span>
                  <span className="bignum__unit">トークン/秒</span>
                </div>
              ) : (
                <div className="idle">
                  <span className="idle__word">アイドル</span>
                  <span className="idle__sub">{llm.lastActiveAt ? `最後の推論 ${ago(llm.lastActiveAt, now)}` : "リクエストを待っています"}</span>
                </div>
              )}
              <dl className="pairs">
                <div>
                  <dt>実行中</dt>
                  <dd>{llm.requestsRunning ?? "–"}</dd>
                </div>
                <div>
                  <dt>待ち</dt>
                  <dd>{llm.requestsWaiting ?? "–"}</dd>
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
                <strong>{pct(kv, 1)}</strong>
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
            {up && spec && (
              <div>
                <dt>投機的デコード</dt>
                <dd>
                  採用率 {spec.acceptRate === null ? "–" : pct(spec.acceptRate * 100)}
                  {spec.meanLength !== null ? `・平均 ${spec.meanLength.toFixed(1)} トークン/検証` : ""}
                </dd>
              </div>
            )}
            {up && spec && running && (spec.draftTokensPerSec !== null || spec.acceptedTokensPerSec !== null) && (
              <div>
                <dt>ドラフト／採用（トークン/秒）</dt>
                <dd>
                  {rate(spec.draftTokensPerSec)} ／ {rate(spec.acceptedTokensPerSec)}
                </dd>
              </div>
            )}
            {up && (
              <>
                <div>
                  <dt>TTFT（平均）</dt>
                  <dd>{llm.ttftSec === null ? "–" : `${llm.ttftSec.toFixed(2)} 秒`}</dd>
                </div>
                <div>
                  <dt>プレフィックスキャッシュ命中率</dt>
                  <dd>{llm.prefixCacheHitRate === null ? "–" : pct(llm.prefixCacheHitRate * 100)}</dd>
                </div>
                <div>
                  <dt>起動からの累計</dt>
                  <dd>
                    {llm.tokensTotal ? `入力 ${count(llm.tokensTotal.prompt)}・出力 ${count(llm.tokensTotal.generation)}` : "–"}
                  </dd>
                </div>
                <div>
                  <dt>連続稼働・API</dt>
                  <dd>
                    {llm.upSince ? duration((now - llm.upSince) / 1000) : "–"}・{shortHost(llm.baseUrl)}
                    {llm.latencyMs !== null ? `（${llm.latencyMs} ms）` : ""}
                  </dd>
                </div>
              </>
            )}
          </dl>

          {nodes.length > 0 && (
            <ul className="nodes">
              {nodes.map((h) => {
                const container = llm.containers.find((c) => c.host === h.id);
                return (
                  <li key={h.id}>
                    <span className="nodes__name">{h.label}</span>
                    <span className="nodes__meta">{container ? dockerStatus(container.status) : h.online ? "コンテナなし" : "応答なし"}</span>
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
