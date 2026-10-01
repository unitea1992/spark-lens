import { useEffect, useState } from "react";

export type Page = "lab" | "usage" | "agents";

export const PAGES: { id: Page; label: string; short: string }[] = [
  { id: "lab", label: "ローカル AI", short: "ローカル AI" },
  { id: "usage", label: "利用状況", short: "利用状況" },
  { id: "agents", label: "エージェント", short: "エージェント" },
];

// Earlier page names, so old bookmarks still land somewhere sensible.
const ALIASES: Record<string, Page> = {
  "": "lab",
  overview: "lab",
  local: "lab",
  machines: "lab",
  llm: "lab",
  subscriptions: "usage",
};

export function pageFromHash(hash: string): Page {
  const id = hash.replace(/^#\/?/, "");
  return PAGES.find((p) => p.id === id)?.id ?? ALIASES[id] ?? "lab";
}

/**
 * Pages live in the URL hash (#/usage), so the back button, reloads and
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
