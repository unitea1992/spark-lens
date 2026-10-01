import { useState } from "react";
import type { RecipeSnapshot } from "../../../server/types.ts";
import { ago, shortDate } from "../format.ts";
import { act, LogViewer } from "./RecipeCard.tsx";
import { StatusPill, type Tone } from "./StatusPill.tsx";

const STATUS: Record<RecipeSnapshot["status"], { tone: Tone; text: string }> = {
  running: { tone: "good", text: "稼働中" },
  starting: { tone: "warn", text: "起動中" },
  stopping: { tone: "warn", text: "停止中…" },
  updating: { tone: "warn", text: "更新中" },
  stopped: { tone: "quiet", text: "停止" },
  failed: { tone: "critical", text: "起動失敗" },
};

function upstreamNote(r: RecipeSnapshot): { text: string; tone: "quiet" | "accent" | "warn" } {
  const up = r.upstream;
  if (!up) return { text: "upstream 確認中", tone: "quiet" };
  if (up.state === "behind") return { text: `更新 ${up.behind} 件`, tone: "accent" };
  if (up.state === "modified") return { text: "手元に変更あり", tone: "warn" };
  if (up.state === "current") return { text: `最新${up.headDate ? `（${shortDate(up.headDate)}）` : ""}`, tone: "quiet" };
  if (up.state === "error") return { text: "upstream 確認失敗", tone: "warn" };
  return { text: "upstream なし", tone: "quiet" };
}

type Pending = "switch" | "update" | null;

function Row({ recipe, now }: { recipe: RecipeSnapshot; now: number }) {
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logs, setLogs] = useState(false);
  const st = STATUS[recipe.status];
  const up = upstreamNote(recipe);
  const busy = recipe.status === "starting" || recipe.status === "stopping" || recipe.status === "updating";
  const blocked = !recipe.canStart && recipe.blockedBy !== null && recipe.status === "stopped";

  const check = async () => setNotice(await act(recipe.id, "check"));

  const run = async (op: "start" | "switch" | "update") => {
    setPending(null);
    setNotice(await act(recipe.id, op));
    if (op !== "update") setLogs(true);
  };

  return (
    <li className={`rrow rrow--${recipe.status}`}>
      <div className="rrow__main">
        <StatusPill tone={st.tone}>{st.text}</StatusPill>
        <span className="rrow__name">{recipe.label}</span>
        <span className="rrow__meta">実行先 {recipe.hostLabel}</span>
        {recipe.upstream?.repo && recipe.upstream.repoUrl && (
          <a className="upstream__repo" href={recipe.upstream.repoUrl} target="_blank" rel="noopener noreferrer">
            {recipe.upstream.repo}
          </a>
        )}
        <span className={`rrow__up rrow__up--${up.tone}`}>{up.text}</span>
        {recipe.upstream && <span className="rrow__checked">{ago(recipe.upstream.checkedAt, now)}に確認</span>}
        <button type="button" className="link-button" onClick={() => void check()}>
          今すぐ確認
        </button>
      </div>
      {recipe.upstream?.state === "behind" && recipe.upstream.commits.length > 0 && (
        <ul className="upstream__commits rrow__commits">
          {recipe.upstream.commits.slice(0, 3).map((c) => (
            <li key={c.sha}>
              <span>{c.subject}</span>
              <span>{c.date ? shortDate(c.date) : c.sha}</span>
            </li>
          ))}
          {recipe.upstream.commits.length > 3 && <li className="muted">ほか {recipe.upstream.commits.length - 3} 件</li>}
        </ul>
      )}
      <div className="rrow__actions">
        {pending ? (
          <span className="rrow__confirm">
            {pending === "switch" ? `${recipe.blockedBy} を停止して切り替えます。` : "upstream の更新を取り込みます。"}
            <button type="button" className="btn btn--primary btn--small" onClick={() => void run(pending)}>
              {pending === "switch" ? "切り替える" : "更新する"}
            </button>
            <button type="button" className="btn btn--small" onClick={() => setPending(null)}>
              やめる
            </button>
          </span>
        ) : (
          <>
            {recipe.upstream?.state === "behind" && (
              <button type="button" className="link-button" disabled={!recipe.canUpdate} onClick={() => setPending("update")}>
                更新する
              </button>
            )}
            <button type="button" className="link-button" aria-expanded={logs} onClick={() => setLogs((v) => !v)}>
              {logs ? "ログを閉じる" : "ログ"}
            </button>
            {blocked ? (
              <button type="button" className="btn btn--small" onClick={() => setPending("switch")}>
                このモデルに切り替える
              </button>
            ) : (
              <button type="button" className="btn btn--primary btn--small" disabled={!recipe.canStart || busy} onClick={() => void run("start")}>
                起動する
              </button>
            )}
          </>
        )}
      </div>
      {(notice || (recipe.lastAction?.ok === false && recipe.lastAction.message)) && (
        <p className={`rrow__notice${recipe.lastAction?.ok === false && !notice ? " rrow__notice--bad" : ""}`}>
          {notice ?? recipe.lastAction?.message}
          {recipe.lastAction && !notice ? `（${ago(recipe.lastAction.finishedAt ?? recipe.lastAction.startedAt, now)}）` : ""}
        </p>
      )}
      {logs && <LogViewer id={recipe.id} hasServerLog={recipe.hasServerLog} live={busy} />}
    </li>
  );
}

/**
 * Every recipe that is not running, one line each. A running model gets the
 * full card above; this list grows by a line per recipe, not by a card.
 */
export function RecipeList({ recipes, now }: { recipes: RecipeSnapshot[]; now: number }) {
  return (
    <ul className="card rlist">
      {recipes.map((r) => (
        <Row key={r.id} recipe={r} now={now} />
      ))}
    </ul>
  );
}
