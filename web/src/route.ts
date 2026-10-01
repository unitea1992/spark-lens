import { useEffect, useState } from "react";

export type Page = "overview" | "local" | "usage" | "agents";

export const PAGES: { id: Page; label: string; short: string }[] = [
  { id: "overview", label: "概要", short: "概要" },
  { id: "local", label: "ローカル AI", short: "ローカル" },
  { id: "usage", label: "利用状況", short: "利用状況" },
  { id: "agents", label: "エージェント", short: "エージェント" },
];

// Earlier page names, so old bookmarks still land somewhere sensible.
const ALIASES: Record<string, Page> = { machines: "local", llm: "local", subscriptions: "usage" };

export function pageFromHash(hash: string): Page {
  const id = hash.replace(/^#\/?/, "");
  return PAGES.find((p) => p.id === id)?.id ?? ALIASES[id] ?? "overview";
}

/**
 * Pages live in the URL hash (#/local), so the back button, reloads and
 * bookmarks all land where the viewer was, with no server routes needed.
 */
export function useRoute(): Page {
  const [page, setPage] = useState<Page>(() => pageFromHash(location.hash));
  useEffect(() => {
    const onChange = () => {
      setPage(pageFromHash(location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return page;
}
