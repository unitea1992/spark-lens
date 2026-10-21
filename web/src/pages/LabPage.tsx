import type { Snapshot } from "../../../server/types.ts";
import { LabMap } from "../components/LabMap.tsx";
import { LlmPanel } from "../components/LlmPanel.tsx";
import { MachineCard } from "../components/MachineCard.tsx";
import { RecipeList } from "../components/RecipeList.tsx";

export function LabPage({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  // Only models that are up, coming up, or mid-operation get a full card;
  // every other recipe is one line in the list below them.
  const inFlight = (r: { status: string }) => r.status === "starting" || r.status === "stopping" || r.status === "updating";
  const active = snapshot.llms.filter(
    (l) => l.state !== "down" || snapshot.recipes.some((r) => r.llm === l.id && inFlight(r)),
  );
  const activeIds = new Set(active.map((l) => l.id));
  const idle = snapshot.recipes.filter((r) => !r.llm || !activeIds.has(r.llm));

  return (
    <>
      <LabMap snapshot={snapshot} now={now} />
      {(snapshot.llms.length > 0 || snapshot.recipes.length > 0) && (
        <section aria-labelledby="h-llm">
          <h2 id="h-llm">モデル</h2>
          {active.length > 0 && (
            <div className="grid grid--llm">
              {active.map((l) => (
                <LlmPanel
                  key={l.id}
                  llm={l}
                  hosts={snapshot.hosts}
                  recipes={snapshot.recipes.filter((r) => r.llm === l.id)}
                  bench={snapshot.bench?.[l.id]}
                  now={now}
                />
              ))}
            </div>
          )}
          {idle.length > 0 && (
            <>
              <h3 className="subhead">{active.length > 0 ? "ほかのレシピ" : "レシピ"}</h3>
              <RecipeList recipes={idle} now={now} />
            </>
          )}
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
  );
}
