import type { Snapshot } from "../../../server/types.ts";
import { AgentList } from "../components/AgentList.tsx";

export function AgentsPage({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const working = snapshot.agents.filter((a) => a.status === "working").length;
  const waiting = snapshot.agents.filter((a) => a.status === "waiting").length;

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
        </p>
      </div>
      <AgentList agents={snapshot.agents} now={now} multiHost={snapshot.hosts.length > 1} />
    </section>
  );
}
