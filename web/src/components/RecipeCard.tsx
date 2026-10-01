import { useEffect, useRef, useState } from "react";
import type { RecipeSnapshot } from "../../../server/types.ts";
import { ago } from "../format.ts";

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
    // Follow along while something is happening; otherwise one read is enough.
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

/**
 * Start/stop for one recipe. Only the action that makes sense right now is
 * offered; the model's own status shows whether it is running.
 */
export function RecipeControls({ recipe, now, showName }: { recipe: RecipeSnapshot; now: number; showName?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const live = recipe.status === "starting" || recipe.status === "stopping";
  const last = recipe.lastAction;
  const stopMode = recipe.canStop || recipe.status === "running" || recipe.status === "stopping";

  // A fresh message from the server replaces the click acknowledgement.
  useEffect(() => setNotice(null), [last?.message, last?.finishedAt]);

  const run = async (op: "start" | "stop") => {
    setConfirming(false);
    setNotice(await act(recipe.id, op));
    if (op === "start") setShowLogs(true);
  };

  const reason =
    recipe.status === "starting"
      ? "起動処理中です"
      : recipe.status === "stopping"
        ? "停止処理中です"
        : recipe.blockedBy
          ? `${recipe.blockedBy} が同じマシンで動いています。先にそちらを停止してください`
          : null;

  return (
    <div className="recipe">
      <div className="recipe__bar">
        {showName && <span className="recipe__name">{recipe.label}</span>}
        <span className="recipe__where">実行先: {recipe.hostLabel}</span>
        <button type="button" className="btn btn--quiet" aria-expanded={showLogs} onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? "ログを閉じる" : "ログ"}
        </button>
        {confirming ? (
          <span className="recipe__confirm">
            <span>推論中のリクエストも止まります。</span>
            <button type="button" className="btn btn--danger" onClick={() => run("stop")}>
              停止する
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              やめる
            </button>
          </span>
        ) : stopMode ? (
          <button type="button" className="btn btn--outline-danger" disabled={!recipe.canStop} onClick={() => setConfirming(true)}>
            {recipe.status === "stopping" ? "停止中…" : "停止する"}
          </button>
        ) : (
          <button type="button" className="btn btn--primary" disabled={!recipe.canStart} onClick={() => run("start")}>
            {recipe.status === "starting" ? "起動中…" : "起動する"}
          </button>
        )}
      </div>
      {!recipe.canStart && !recipe.canStop && reason && <p className="muted recipe__reason">{reason}</p>}
      {(notice || (last?.message && last.ok === false)) && (
        <p className={`notice ${last?.ok === false && !notice ? "notice--critical" : ""}`}>
          {notice ?? last?.message}
          {last && !notice && <span className="notice__detail">{ago(last.finishedAt ?? last.startedAt, now)}</span>}
        </p>
      )}
      {showLogs && <LogViewer id={recipe.id} hasServerLog={recipe.hasServerLog} live={live} />}
    </div>
  );
}
