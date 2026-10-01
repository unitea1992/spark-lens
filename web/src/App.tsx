import { useEffect, useState } from "react";
import type { Snapshot } from "../../server/types.ts";
import { AgentList } from "./components/AgentList.tsx";
import { LlmPanel } from "./components/LlmPanel.tsx";
import { MachineCard } from "./components/MachineCard.tsx";
import { ModelUsage } from "./components/ModelUsage.tsx";
import { SubscriptionCard } from "./components/SubscriptionCard.tsx";
import { clock } from "./format.ts";
import { useSnapshot, type Link } from "./useSnapshot.ts";

type Theme = "auto" | "light" | "dark";
const THEME_LABEL: Record<Theme, string> = { auto: "自動", light: "ライト", dark: "ダーク" };
const THEME_NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : "auto";
  });
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "auto") localStorage.removeItem("spark-lens-theme");
      else localStorage.setItem("spark-lens-theme", theme);
    } catch {
      // Private mode: the choice simply does not persist.
    }
  }, [theme]);
  return [theme, () => setTheme((t) => THEME_NEXT[t])];
}

const LINK_TEXT: Record<Link, string> = {
  connecting: "接続中…",
  live: "ライブ",
  lost: "再接続中…",
};

/** One sentence that answers "is anything wrong, is anything busy?" */
function headline(s: Snapshot): { text: string; tone: "good" | "warn" } {
  const offline = s.hosts.filter((h) => !h.online);
  const parts: string[] = [];
  parts.push(
    offline.length === 0
      ? `マシン ${s.hosts.length} 台すべて稼働中`
      : `${offline.map((h) => h.label).join("・")} が応答していません`,
  );
  for (const llm of s.llms) {
    if (llm.state === "up") {
      const running = llm.requestsRunning ?? 0;
      parts.push(running > 0 ? `${llm.label} は ${running} 件を推論中` : `${llm.label} は待機中`);
    } else {
      parts.push(`${llm.label} は${llm.state === "starting" ? "起動中" : "停止中"}`);
    }
  }
  const working = s.agents.filter((a) => a.status === "working").length;
  const waiting = s.agents.filter((a) => a.status === "waiting").length;
  if (waiting > 0) parts.push(`エージェント ${waiting} 件が入力待ち`);
  parts.push(working > 0 ? `エージェント ${working} 件が作業中` : "作業中のエージェントなし");
  const tight = s.subscriptions.filter((sub) => sub.windows.some((w) => (w.usedPct ?? 0) >= 80));
  if (tight.length > 0) parts.push(`${tight.map((t) => t.label).join("・")} の利用枠が残りわずか`);
  return { text: `${parts.join("、")}。`, tone: offline.length > 0 || waiting > 0 || tight.length > 0 ? "warn" : "good" };
}

const SECTIONS = [
  { id: "machines", label: "マシン" },
  { id: "llm", label: "ローカル LLM" },
  { id: "subscriptions", label: "クラウド利用枠" },
  { id: "agents", label: "エージェント" },
];

export function App() {
  const { snapshot, link, now } = useSnapshot();
  const [theme, cycleTheme] = useTheme();

  return (
    <div className="page">
      <header className="top">
        <div className="top__brand">
          <svg className="top__mark" viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" strokeLinecap="round" strokeWidth="6">
              <path className="series-1" d="M32 8a24 24 0 1 1-20.8 12" />
              <path className="series-2" d="M32 19a13 13 0 1 0 12.6 9.8" />
            </g>
            <circle className="series-fill-3" cx="32" cy="32" r="4.5" />
          </svg>
          <h1>Spark Lens</h1>
        </div>
        <div className="top__status">
          <span className={`link link--${link}`} role="status">
            <span className="link__dot" aria-hidden="true" />
            {LINK_TEXT[link]}
            {snapshot && link !== "connecting" ? `　${clock(snapshot.generatedAt)} 更新` : ""}
          </span>
          <button type="button" className="button" onClick={cycleTheme} aria-label={`配色を切り替える（現在: ${THEME_LABEL[theme]}）`}>
            配色: {THEME_LABEL[theme]}
          </button>
        </div>
      </header>

      {!snapshot ? (
        <p className="loading">{link === "lost" ? "サーバーに接続できません。再接続を試みています…" : "最初のデータを待っています…"}</p>
      ) : (
        <Dashboard snapshot={snapshot} now={now} stale={link === "lost"} />
      )}
    </div>
  );
}

function Dashboard({ snapshot, now, stale }: { snapshot: Snapshot; now: number; stale: boolean }) {
  const head = headline(snapshot);
  const sections = SECTIONS.filter((s) => s.id !== "llm" || snapshot.llms.length > 0);
  return (
    <main className={stale ? "stale" : ""}>
      {stale && (
        <p className="notice notice--warn banner">
          サーバーとの接続が切れています。表示は {clock(snapshot.generatedAt)} 時点のものです。
        </p>
      )}
      <p className={`headline headline--${head.tone}`}>{head.text}</p>

      <nav className="jump" aria-label="セクション">
        {sections.map((s) => (
          <a key={s.id} href={`#${s.id}`}>
            {s.label}
          </a>
        ))}
      </nav>

      <section id="machines" aria-labelledby="h-machines">
        <h2 id="h-machines">マシン</h2>
        <div className="grid grid--machines">
          {snapshot.hosts.map((h) => (
            <MachineCard key={h.id} host={h} now={now} />
          ))}
        </div>
      </section>

      {snapshot.llms.length > 0 && (
        <section id="llm" aria-labelledby="h-llm">
          <h2 id="h-llm">ローカル LLM</h2>
          <div className="grid grid--llm">
            {snapshot.llms.map((l) => (
              <LlmPanel key={l.id} llm={l} hosts={snapshot.hosts} now={now} />
            ))}
          </div>
        </section>
      )}

      <section id="subscriptions" aria-labelledby="h-subs">
        <h2 id="h-subs">クラウド利用枠</h2>
        {snapshot.subscriptions.some((x) => x.windows.length > 0) && (
          <p className="section__hint">
            <span className="tick" aria-hidden="true" />
            縦線は期間の経過位置です。バーが縦線より右なら、均等に使うより速いペースです。
          </p>
        )}
        {snapshot.subscriptions.length === 0 ? (
          <div className="card empty">
            <p>表示するサービスが設定されていません。</p>
            <p className="muted">設定ファイルの subscriptions に追加すると、ここに利用枠が並びます。</p>
          </div>
        ) : (
          <div className="grid grid--subs">
            {snapshot.subscriptions.map((s) => (
              <SubscriptionCard key={s.id} sub={s} now={now} />
            ))}
          </div>
        )}
      </section>

      <section id="agents" aria-labelledby="h-agents">
        <h2 id="h-agents">エージェント</h2>
        <AgentList agents={snapshot.agents} now={now} multiHost={snapshot.hosts.length > 1} />
        <h3 className="subhead">モデル別の利用量</h3>
        <ModelUsage usage={snapshot.usage} />
      </section>

      <footer className="foot">
        Spark Lens {snapshot.version}・{snapshot.pollSeconds} 秒ごとに更新
      </footer>
    </main>
  );
}
