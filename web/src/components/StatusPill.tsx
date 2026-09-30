import type { ReactNode } from "react";

export type Tone = "good" | "warn" | "critical" | "busy" | "quiet";

// Status is never colour alone: each tone carries its own glyph next to the label.
const GLYPH: Record<Tone, string> = {
  good: "●",
  warn: "▲",
  critical: "■",
  busy: "◆",
  quiet: "○",
};

export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`pill pill--${tone}`}>
      <span className="pill__glyph" aria-hidden="true">
        {GLYPH[tone]}
      </span>
      {children}
    </span>
  );
}
