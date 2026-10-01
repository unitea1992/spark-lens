import { useEffect, useState } from "react";

export type Page = "overview" | "machines" | "llm" | "subscriptions" | "agents";

export const PAGES: { id: Page; label: string; short: string }[] = [
  { id: "overview", label: "概要", short: "概要" },
  { id: "machines", label: "マシン", short: "マシン" },
  { id: "llm", label: "ローカル LLM", short: "LLM" },
  { id: "subscriptions", label: "クラウド利用枠", short: "利用枠" },
  { id: "agents", label: "エージェント", short: "エージェント" },
];

function fromHash(hash: string): Page {
  const id = hash.replace(/^#\/?/, "");
  return PAGES.find((p) => p.id === id)?.id ?? "overview";
}

/**
 * Pages live in the URL hash (#/machines), so the back button, reloads and
 * bookmarks all land where the viewer was, with no server routes needed.
 */
export function useRoute(): Page {
  const [page, setPage] = useState<Page>(() => fromHash(location.hash));
  useEffect(() => {
    const onChange = () => {
      setPage(fromHash(location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return page;
}
