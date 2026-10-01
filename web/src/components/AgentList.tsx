import type { AgentSnapshot, AgentStatus } from "../../../server/types.ts";
import { ago } from "../format.ts";
import { StatusPill, type Tone } from "./StatusPill.tsx";

const STATUS: Record<AgentStatus, { tone: Tone; text: string }> = {
  working: { tone: "busy", text: "作業中" },
  waiting: { tone: "warn", text: "入力待ち" },
  idle: { tone: "quiet", text: "待機中" },
  unknown: { tone: "quiet", text: "不明" },
};

function projectName(cwd: string | null): string {
  if (!cwd) return "場所不明";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

const RECENT_MS = 60 * 60 * 1000;

function Row({ a, now, multiHost }: { a: AgentSnapshot; now: number; multiHost: boolean }) {
  const st = STATUS[a.status];
  const activity = a.lastActivity ?? a.startedAt;
  return (
    <li className={`agent agent--${a.status}`}>
      <div className="agent__state">
        <StatusPill tone={st.tone}>{st.text}</StatusPill>
      </div>
      <div className="agent__main">
        <p className="agent__title">
          <span className="agent__tool">{a.toolLabel}</span>
          <span className="agent__project">{projectName(a.cwd)}</span>
        </p>
        <p className="agent__task">{a.title ?? "（タイトルなし）"}</p>
      </div>
      <div className="agent__meta">
        <span title={a.cwd ?? undefined}>{a.cwd ?? ""}</span>
        <span>
          {multiHost ? `${a.hostLabel}・` : ""}
          {a.detail ? `${a.detail}・` : ""}
          {activity ? ago(activity, now) : ""}
        </span>
      </div>
    </li>
  );
}

export function AgentList({ agents, now, multiHost }: { agents: AgentSnapshot[]; now: number; multiHost: boolean }) {
  // Sessions that are running, or only just went quiet, stay in view; older
  // finished ones fold away so they cannot bury live work.
  const current = agents.filter(
    (a) => a.status === "working" || a.status === "waiting" || a.pid !== null || (a.lastActivity ?? 0) > now - RECENT_MS,
  );
  const earlier = agents.filter((a) => !current.includes(a));
  return (
    <>
      {current.length === 0 ? (
        <div className="card empty">
          <p>いま動いているエージェントはありません。</p>
          <p className="muted">Claude Code・Codex・OpenCode を起動すると、ここに作業状況が並びます。</p>
        </div>
      ) : (
        <ul className="card agents">
          {current.map((a) => (
            <Row key={a.id} a={a} now={now} multiHost={multiHost} />
          ))}
        </ul>
      )}
      {earlier.length > 0 && (
        <details className="earlier">
          <summary>最後の動きから 1 時間以上たったセッション（{earlier.length} 件）</summary>
          <ul className="card agents">
            {earlier.map((a) => (
              <Row key={a.id} a={a} now={now} multiHost={multiHost} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
