import type { Snapshot } from "../../../server/types.ts";
import { AgentList } from "../components/AgentList.tsx";

export function AgentsPage({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const sessions = snapshot.agents.filter((a) => a.source !== "process");
  const working = sessions.filter((a) => a.status === "working").length;
  const waiting = sessions.filter((a) => a.status === "waiting").length;
  const unknown = sessions.filter((a) => a.status === "unknown").length;
  const processOnly = snapshot.agents.length - sessions.length;

  return (
    <section aria-labelledby="h-agents">
      <div className="page-head">
        <h2 id="h-agents">エージェント</h2>
        <p className="page-head__count">
          作業中 <strong>{working}</strong>
          {waiting > 0 && (
            <>
              {" / "}入力待ち <strong className="warn-text">{waiting}</strong>
            </>
          )}
          {unknown > 0 && <> / 状態不明 <strong>{unknown}</strong></>}
          {processOnly > 0 && <> / 起動のみ <strong>{processOnly}</strong></>}
        </p>
      </div>
      <AgentList agents={snapshot.agents} now={now} multiHost={snapshot.hosts.length > 1} />
      <details className="monitor-editor">
        <summary>検出元と精度</summary>
        <div className="monitor-editor__body">
          {snapshot.agentSources && <ul className="monitor-editor__list">
            {snapshot.agentSources.map((source) => <li key={source.source}>
              <span><strong>{source.label}</strong><small>{source.count}件検出</small></span>
              <span>{source.state === "queried" ? "取得を実行" : source.state === "unavailable" ? "未検出" : "取得失敗"}</span>
            </li>)}
          </ul>}
          <p>Claude Code はセッション記録、Codex は実行ログ、OpenCode はセッションAPI、Orca は管理ペインの情報を読みます。</p>
          <p>Pi・DSH・Gemini CLI・Grok などは、Orca管理下ならペインの状態、それ以外はプロセスの存在だけを確認します。状態を持たないプロセスは通常のセッションと分けて下部に表示します。</p>
          <p>検出元が応答しない場合、画面に出ないセッションもあります。数値は管理可能な全エージェント数を保証しません。</p>
        </div>
      </details>
    </section>
  );
}
