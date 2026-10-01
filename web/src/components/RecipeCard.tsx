import { useEffect, useRef, useState } from "react";
import type { RecipeSnapshot } from "../../../server/types.ts";
import { ago } from "../format.ts";
import { StatusPill, type Tone } from "./StatusPill.tsx";

const STATUS: Record<RecipeSnapshot["status"], { tone: Tone; text: string }> = {
  running: { tone: "good", text: "稼働中" },
  starting: { tone: "warn", text: "起動中" },
  stopping: { tone: "warn", text: "停止中…" },
  stopped: { tone: "quiet", text: "停止" },
  failed: { tone: "critical", text: "起動失敗" },
};

async function act(id: string, op: "start" | "stop"): Promise<string> {
  try {
    const res = await fetch(`/api/recipes/${id}/${op}`, { method: "POST", headers: { "X-Spark-Lens": "1" } });
    const body = (await res.json()) as { message?: string };
    return body.message ?? (res.ok ? "受け付けました" : "操作できませんでした");
  } catch {
    return "サーバーに接続できませんでした";
  }
}

type Source = "launcher" | "server";

function LogViewer({ id, hasServerLog, live }: { id: string; hasServerLog: boolean; live: boolean }) {
  const [source, setSource] = useState<Source>("launcher");
  const [text, setText] = useState("読み込み中…");
  const pre = useRef<HTMLPreElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/recipes/${id}/logs?source=${source}`);
        const body = (await res.json()) as { text?: string };
        if (!stopped) setText(body.text ?? "");
      } catch {
        if (!stopped) setText("ログを取得できませんでした");
      }
    };
    void load();
    // Follow along while something is happening; otherwise a manual refresh is enough.
    const timer = live ? setInterval(load, 3000) : null;
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [id, source, live]);

  useEffect(() => {
    const el = pre.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <div className="logs">
      <div className="toggle" role="group" aria-label="ログの種類">
        <button type="button" aria-pressed={source === "launcher"} onClick={() => setSource("launcher")}>
          起動ログ
        </button>
        {hasServerLog && (
          <button type="button" aria-pressed={source === "server"} onClick={() => setSource("server")}>
            サーバーログ
          </button>
        )}
      </div>
      <pre
        ref={pre}
        className="logs__text"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {text}
      </pre>
    </div>
  );
}

export function RecipeCard({ recipe, now }: { recipe: RecipeSnapshot; now: number }) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const st = STATUS[recipe.status];
  const live = recipe.status === "starting" || recipe.status === "stopping";
  const last = recipe.lastAction;

  const run = async (op: "start" | "stop") => {
    setConfirming(false);
    setNotice(await act(recipe.id, op));
    if (op === "start") setShowLogs(true);
  };

  return (
    <article className="card recipe">
      <header className="card__head">
        <div>
          <h3 className="card__title">{recipe.label}</h3>
          <p className="card__sub">{recipe.hostLabel} で実行</p>
        </div>
        <StatusPill tone={st.tone}>{st.text}</StatusPill>
      </header>

      {(notice || last?.message) && (
        <p className={`notice ${last?.ok === false ? "notice--critical" : ""}`}>
          {notice ?? last?.message}
          {last && <span className="notice__detail">{ago(last.finishedAt ?? last.startedAt, now)}</span>}
        </p>
      )}

      <div className="recipe__actions">
        {confirming ? (
          <>
            <span className="recipe__ask">推論中のリクエストも止まります。停止しますか？</span>
            <button type="button" className="btn btn--danger" onClick={() => run("stop")}>
              停止する
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              やめる
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn--primary" disabled={!recipe.canStart} onClick={() => run("start")}>
              起動
            </button>
            <button type="button" className="btn" disabled={!recipe.canStop} onClick={() => setConfirming(true)}>
              停止
            </button>
            <button type="button" className="btn btn--quiet" aria-expanded={showLogs} onClick={() => setShowLogs((v) => !v)}>
              {showLogs ? "ログを閉じる" : "ログを見る"}
            </button>
          </>
        )}
      </div>
      {recipe.blockedBy && !recipe.canStart && recipe.status === "stopped" && (
        <p className="muted">{recipe.blockedBy} が同じマシンで動いているため、起動するにはそちらを先に停止してください。</p>
      )}

      {showLogs && <LogViewer id={recipe.id} hasServerLog={recipe.hasServerLog} live={live} />}
    </article>
  );
}
