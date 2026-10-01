import { useEffect, useState } from "react";
import type { Snapshot } from "../../server/types.ts";
import { AgentList } from "./components/AgentList.tsx";
import { LlmPanel } from "./components/LlmPanel.tsx";
import { MachineCard } from "./components/MachineCard.tsx";
import { ModelUsage } from "./components/ModelUsage.tsx";
import { RecipeControls } from "./components/RecipeCard.tsx";
import { SubscriptionCard } from "./components/SubscriptionCard.tsx";
import { alerts, llmStatus, Overview } from "./components/Overview.tsx";
import { StatusPill, type Tone } from "./components/StatusPill.tsx";
import { clock } from "./format.ts";
import { PAGES, useRoute, type Page } from "./route.ts";
import { useSnapshot, type Link } from "./useSnapshot.ts";

type Theme = "auto" | "light" | "dark";
const THEME_LABEL: Record<Theme, string> = { auto: "端末に合わせる", light: "ライト", dark: "ダーク" };
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

interface Chip {
  text: string;
  tone: Tone;
  to: Page;
}

/**
 * The status strip on the overview. Anything that needs attention comes
 * first, in amber or red; the calm summary of each area follows.
 */
function statusChips(s: Snapshot, now: number): Chip[] {
  const chips: Chip[] = alerts(s, now).map((a) => ({ text: a.text, tone: a.tone, to: a.to }));
  const online = s.hosts.filter((h) => h.online).length;
  if (online === s.hosts.length) chips.push({ text: `マシン ${online}/${s.hosts.length}`, tone: "good", to: "local" });
  for (const l of s.llms) {
    const st = llmStatus(l);
    chips.push({ text: `${l.label} ${st.text}`, tone: st.tone, to: "local" });
  }
  if (!chips.some((c) => c.to === "usage")) chips.push({ text: "クラウド利用枠 余裕あり", tone: "good", to: "usage" });
  const working = s.agents.filter((a) => a.status === "working").length;
  chips.push({ text: working > 0 ? `作業中 ${working}` : "作業中なし", tone: working > 0 ? "busy" : "quiet", to: "agents" });
  return chips;
}

function ThemeIcon({ theme }: { theme: Theme }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-icon">
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      {theme === "auto" && <path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" />}
      {theme === "dark" && <circle cx="12" cy="12" r="7.5" fill="currentColor" />}
    </svg>
  );
}

export function App() {
  const { snapshot, link, now } = useSnapshot();
  const [theme, cycleTheme] = useTheme();
  const page = useRoute();

  useEffect(() => {
    const current = PAGES.find((p) => p.id === page);
    document.title = page === "overview" ? "Spark Lens" : `${current?.label} | Spark Lens`;
  }, [page]);

  return (
    <div className="page">
      <header className="top">
        <a className="top__brand" href="#/">
          <svg className="top__mark" viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" strokeLinecap="round" strokeWidth="6">
              <path className="series-1" d="M32 8a24 24 0 1 1-20.8 12" />
              <path className="series-2" d="M32 19a13 13 0 1 0 12.6 9.8" />
            </g>
            <circle className="series-fill-3" cx="32" cy="32" r="4.5" />
          </svg>
          <span className="top__name">Spark Lens</span>
        </a>
        <nav className="tabs" aria-label="ページ">
          {PAGES.map((p) => (
            <a key={p.id} href={`#/${p.id}`} aria-current={page === p.id ? "page" : undefined}>
              {p.label}
            </a>
          ))}
        </nav>
        <div className="top__status">
          <span className={`link link--${link}`} role="status" title={LINK_TEXT[link]}>
            <span className="link__dot" aria-hidden="true" />
            <span className="link__text">{LINK_TEXT[link]}</span>
            {snapshot && link !== "connecting" ? <span>{clock(snapshot.generatedAt)}</span> : null}
          </span>
          <button
            type="button"
            className="icon-button"
            onClick={cycleTheme}
            title={`配色: ${THEME_LABEL[theme]}`}
            aria-label={`配色を切り替える（現在: ${THEME_LABEL[theme]}）`}
          >
            <ThemeIcon theme={theme} />
          </button>
        </div>
      </header>

      {!snapshot ? (
        <p className="loading">{link === "lost" ? "サーバーに接続できません。再接続を試みています…" : "最初のデータを待っています…"}</p>
      ) : (
        <Dashboard snapshot={snapshot} now={now} stale={link === "lost"} page={page} />
      )}

      <nav className="bottom-tabs" aria-label="ページ">
        {PAGES.map((p) => (
          <a key={p.id} href={`#/${p.id}`} aria-current={page === p.id ? "page" : undefined}>
            <TabIcon page={p.id} />
            <span>{p.short}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

function TabIcon({ page }: { page: Page }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="tab-icon">
      {page === "overview" && (
        <g {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.5" />
        </g>
      )}
      {page === "local" && (
        <g {...common}>
          <rect x="6" y="6" width="12" height="12" rx="2" />
          <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
        </g>
      )}
      {page === "usage" && (
        <g {...common}>
          <path d="M4 18a8 8 0 1 1 16 0" />
          <path d="M12 18l4-5" />
        </g>
      )}
      {page === "agents" && (
        <g {...common}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </g>
      )}
    </svg>
  );
}

function Dashboard({ snapshot, now, stale, page }: { snapshot: Snapshot; now: number; stale: boolean; page: Page }) {
  const linked = new Set(snapshot.recipes.filter((r) => r.llm && snapshot.llms.some((l) => l.id === r.llm)).map((r) => r.id));
  const loose = snapshot.recipes.filter((r) => !linked.has(r.id));
  return (
    <main className={stale ? "stale" : ""}>
      {stale && (
        <p className="notice notice--warn banner">
          サーバーとの接続が切れています。表示は {clock(snapshot.generatedAt)} 時点のものです。
        </p>
      )}

      {page === "overview" && (
        <>
          <ul className="chips" aria-label="全体の状態">
            {statusChips(snapshot, now).map((c) => (
              <li key={c.text}>
                <a href={`#/${c.to}`}>
                  <StatusPill tone={c.tone}>{c.text}</StatusPill>
                </a>
              </li>
            ))}
          </ul>
          <Overview snapshot={snapshot} now={now} />
        </>
      )}

      {page === "local" && (
        <>
          {(snapshot.llms.length > 0 || loose.length > 0) && (
            <section aria-labelledby="h-llm">
              <h2 id="h-llm">ローカル LLM</h2>
              <div className="grid grid--llm">
                {snapshot.llms.map((l) => (
                  <LlmPanel key={l.id} llm={l} hosts={snapshot.hosts} recipes={snapshot.recipes.filter((r) => r.llm === l.id)} now={now} />
                ))}
                {loose.map((r) => (
                  <div key={r.id} className="card">
                    <RecipeControls recipe={r} now={now} showName />
                  </div>
                ))}
              </div>
            </section>
          )}
          <section aria-labelledby="h-machines">
            <h2 id="h-machines">マシン</h2>
            <div className="grid grid--machines">
              {snapshot.hosts.map((h) => (
                <MachineCard key={h.id} host={h} now={now} />
              ))}
            </div>
          </section>
        </>
      )}

      {page === "usage" && (
        <>
          <section aria-labelledby="h-subs">
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
          <section aria-labelledby="h-models">
            <h2 id="h-models">モデル別の利用量</h2>
            <ModelUsage usage={snapshot.usage} />
          </section>
        </>
      )}

      {page === "agents" && (
        <section aria-labelledby="h-agents">
          <h2 id="h-agents">エージェント</h2>
          <AgentList agents={snapshot.agents} now={now} multiHost={snapshot.hosts.length > 1} />
        </section>
      )}

      <footer className="foot">
        Spark Lens {snapshot.version}・{snapshot.pollSeconds} 秒ごとに更新
      </footer>
    </main>
  );
}
