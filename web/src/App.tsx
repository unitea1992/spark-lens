import { useEffect, useState } from "react";
import type { Snapshot } from "../../server/types.ts";
import { clock } from "./format.ts";
import { AgentsPage } from "./pages/AgentsPage.tsx";
import { LabPage } from "./pages/LabPage.tsx";
import { UsagePage } from "./pages/UsagePage.tsx";
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
          {/* A lens over a pulse, with the spark it brings into focus. */}
          <svg className="top__mark" viewBox="0 0 64 64" aria-hidden="true">
            <g fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path className="series-1" strokeWidth="5.5" d="M38 42 A19 19 0 1 1 44 35" />
              <path className="series-2" strokeWidth="5" d="M41 41 L54 54 M17 28 H23 L27 21 L31 32 L36 25" />
            </g>
            <path className="series-fill-3" d="M37 16 L41 20 L37 24 L33 20 Z" />
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
  // Problems on other pages are shown everywhere, but only while they exist.
  const elsewhere = alerts(snapshot, now).filter((a) => a.page !== page);

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

      {page === "lab" && <LabPage snapshot={snapshot} now={now} />}
      {page === "usage" && <UsagePage snapshot={snapshot} now={now} />}
      {page === "agents" && <AgentsPage snapshot={snapshot} now={now} />}

      <footer className="foot">
        Spark Lens {snapshot.version} / {snapshot.pollSeconds} 秒ごとに更新
      </footer>
    </main>
  );
}
