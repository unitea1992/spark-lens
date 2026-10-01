import type { HostSnapshot, LlmSnapshot, RecipeSnapshot } from "../../../server/types.ts";
import { ago, count, duration, pct, shortHost } from "../format.ts";
import { llmStatus } from "../status.ts";
import { levelFor, Meter } from "./Meter.tsx";
import { RecipeControls } from "./RecipeCard.tsx";
import { Sparkline } from "./Sparkline.tsx";
import { MemoryMap } from "./MemoryMap.tsx";
import { StartProgress } from "./StartProgress.tsx";
import { StatusPill } from "./StatusPill.tsx";

function rate(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : v.toFixed(1);
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
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
  // A start the dashboard is running counts as starting before the server answers.
  const launching = recipes.some((r) => r.status === "starting" || r.status === "updating");
  const st = launching && llm.state === "down" ? { tone: "warn" as const, text: "起動中" } : llmStatus(llm);
  const up = llm.state === "up";
  const running = (llm.requestsRunning ?? 0) > 0;
  const kv = llm.kvCacheUsage === null ? null : llm.kvCacheUsage * 100;
  const spec = llm.spec;
  const where = [...new Set(recipes.map((r) => r.hostLabel))].join("・");
  const sub = [
    llm.models[0],
    llm.engine,
    llm.contextLength ? `コンテキスト長 ${count(llm.contextLength)}` : null,
    where ? `実行先 ${where}` : null,
  ].filter(Boolean);

  return (
    <article className={`card model model--${llm.state}`}>
      <header className="model__head">
        <div className="model__title">
          <h3 className="card__title">{llm.label}</h3>
          <p className="card__sub">{sub.length > 0 ? sub.join("・") : "モデル名は起動後に表示されます"}</p>
        </div>
        <StatusPill tone={st.tone}>{st.text}</StatusPill>
        {recipes.map((r) => (
          <RecipeControls key={r.id} recipe={r} now={now} showName={recipes.length > 1} />
        ))}
      </header>

      {(llm.state === "starting" || recipes.some((r) => r.progress)) && (
        <StartProgress progress={recipes.find((r) => r.progress)?.progress ?? null} now={now} />
      )}
      {llm.detail && llm.state === "up" && <p className="notice notice--warn">{llm.detail}</p>}

      {up && (
        <>
          <div className="tiles">
            <div className="tile tile--hero">
              <span className="tile__label">生成速度</span>
              {running ? (
                <span className="tile__value">
                  {rate(llm.genTokensPerSec)}
                  <small>トークン/秒</small>
                </span>
              ) : (
                <span className="tile__value tile__value--word">
                  アイドル
                  <small>{llm.lastActiveAt ? `最後の推論 ${ago(llm.lastActiveAt, now)}` : "リクエストを待っています"}</small>
                </span>
              )}
            </div>
            <div className="tile">
              <span className="tile__label">リクエスト</span>
              <span className="tile__value">
                {llm.requestsRunning ?? "–"}
                <small>実行</small>
                <span className="tile__sep">/</span>
                {llm.requestsWaiting ?? "–"}
                <small>待ち</small>
              </span>
            </div>
            <div className="tile">
              <span className="tile__label">会話メモリ（KV キャッシュ）</span>
              <span className="tile__value">{pct(kv, 1)}</span>
              <Meter value={kv} level={levelFor(kv, 85, 95)} label="KV キャッシュ使用率" />
            </div>
            <div className="tile">
              <span className="tile__label">今日のトークン</span>
              <span className="tile__value">
                {count(llm.tokensToday.generation)}
                <small>出力</small>
              </span>
              <span className="tile__note">入力 {count(llm.tokensToday.prompt)}</span>
            </div>
          </div>

          {(() => {
            const r = recipes.find((x) => x.memory);
            const head = hosts.find((h) => h.id === (r?.host ?? llm.nodes[0]));
            return head && r?.memory ? (
              <MemoryMap host={head} weightsGiB={r.memory.weightsGiB} kvGiB={r.memory.kvGiB} kvUsage={llm.kvCacheUsage} />
            ) : null;
          })()}

          <Sparkline
            values={llm.history.genTps}
            stepSec={llm.history.stepSec}
            series={1}
            label="生成速度"
            format={(v) => `${v.toFixed(1)} トークン/秒`}
          />

          <dl className="factline">
            {spec && <Fact label="ドラフト採用率" value={spec.acceptRate === null ? "–" : pct(spec.acceptRate * 100)} />}
            {spec && <Fact label="検証あたり" value={spec.meanLength === null ? "–" : `${spec.meanLength.toFixed(1)} トークン`} />}
            {spec && running && <Fact label="ドラフト / 採用" value={`${rate(spec.draftTokensPerSec)} / ${rate(spec.acceptedTokensPerSec)} トークン/秒`} />}
            <Fact label="TTFT（平均）" value={llm.ttftSec === null ? "–" : `${llm.ttftSec.toFixed(2)} 秒`} />
            <Fact label="キャッシュヒット率" value={llm.prefixCacheHitRate === null ? "–" : pct(llm.prefixCacheHitRate * 100)} />
            <Fact
              label="起動からの累計"
              value={llm.tokensTotal ? `入力 ${count(llm.tokensTotal.prompt)}・出力 ${count(llm.tokensTotal.generation)}` : "–"}
            />
            <Fact label="連続稼働" value={llm.upSince ? duration((now - llm.upSince) / 1000) : "–"} />
            <Fact label="API の場所" value={`${shortHost(llm.baseUrl)}/v1`} />
          </dl>
        </>
      )}

      {llm.state === "down" && !launching && (
        <p className="model__down">
          停止中です。{recipes.some((r) => r.canStart) ? "「起動する」で立ち上げられます。" : ""}
          {llm.tokensToday.generation > 0 ? ` 今日の出力 ${count(llm.tokensToday.generation)} トークン。` : ""}
        </p>
      )}
    </article>
  );
}
