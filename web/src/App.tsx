import { useEffect, useState } from "react";
import type { Snapshot } from "../../server/types.ts";
import { AgentList } from "./components/AgentList.tsx";
import { LlmPanel } from "./components/LlmPanel.tsx";
import { MachineCard } from "./components/MachineCard.tsx";
import { ModelUsage } from "./components/ModelUsage.tsx";
import { RecipeControls } from "./components/RecipeCard.tsx";
import { SubscriptionCard } from "./components/SubscriptionCard.tsx";
import { LabMap } from "./components/LabMap.tsx";
import { StatusPill } from "./components/StatusPill.tsx";
import { clock } from "./format.ts";
import { PAGES, useRoute, type Page } from "./route.ts";
import { alerts, badges, type Badge } from "./status.ts";
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

function ThemeIcon({ theme }: { theme: Theme }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="theme-icon">
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      {theme === "auto" && <path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" />}
      {theme === "dark" && <circle cx="12" cy="12" r="7.5" fill="currentColor" />}
    </svg>
  );
}

/** A tab's own status: a dot, or a count, coloured like the pill it stands for. */
function TabBadge({ badge }: { badge: Badge | null }) {
  if (!badge) return null;
  return (
    <span className={`tab-badge tab-badge--${badge.tone}${badge.text ? "" : " tab-badge--dot"}`} title={badge.label}>
      {badge.text}
      <span className="visually-hidden">（{badge.label}）</span>
    </span>
  );
}

export function App() {
  const { snapshot, link, now } = useSnapshot();
  const [theme, cycleTheme] = useTheme();
  const page = useRoute();
  const tabBadges = snapshot ? badges(snapshot, now) : null;

  useEffect(() => {
    const current = PAGES.find((p) => p.id === page);
    document.title = `${current?.label} | Spark Lens`;
  }, [page]);

  return (
    <div className="page">
      <header className="top">
        <a className="top__brand" href="#/lab">
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
              <TabBadge badge={tabBadges?.[p.id] ?? null} />
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
            <span className="bottom-tabs__icon">
              <TabIcon page={p.id} />
              <TabBadge badge={tabBadges?.[p.id] ?? null} />
            </span>
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
      {page === "lab" && (
        <g {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="4.5" />
          <circle cx="12" cy="12" r="1.2" fill="currentColor" />
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
  // Problems on other pages are shown everywhere, but only while they exist.
  const elsewhere = alerts(snapshot, now).filter((a) => a.page !== page);
  const working = snapshot.agents.filter((a) => a.status === "working").length;
  const waiting = snapshot.agents.filter((a) => a.status === "waiting").length;

  return (
    <main className={stale ? "stale" : ""}>
      {stale && (
        <p className="notice notice--warn banner">
          サーバーとの接続が切れています。表示は {clock(snapshot.generatedAt)} 時点のものです。
        </p>
      )}
      {elsewhere.length > 0 && (
        <ul className="alerts" aria-label="ほかのページで要確認">
          {elsewhere.map((a) => (
            <li key={a.text}>
              <a href={`#/${a.page}`} className={`alert alert--${a.tone}`}>
                {a.text}
              </a>
            </li>
          ))}
        </ul>
      )}

      {page === "lab" && (
        <>
          <LabMap snapshot={snapshot} />
          {(snapshot.llms.length > 0 || loose.length > 0) && (
            <section aria-labelledby="h-llm">
              <h2 id="h-llm">モデル</h2>
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
                縦線は期間の経過位置、薄い帯はこのペースで使い続けた場合の期間終了時の見込みです。
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
          <div className="page-head">
            <h2 id="h-agents">エージェント</h2>
            <p className="page-head__count">
              作業中 <strong>{working}</strong>
              {waiting > 0 && (
                <>
                  ・入力待ち <strong className="warn-text">{waiting}</strong>
                </>
              )}
            </p>
          </div>
          <AgentList agents={snapshot.agents} now={now} multiHost={snapshot.hosts.length > 1} />
        </section>
      )}

      <footer className="foot">
        Spark Lens {snapshot.version}・{snapshot.pollSeconds} 秒ごとに更新
      </footer>
    </main>
  );
}
