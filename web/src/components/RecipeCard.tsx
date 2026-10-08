import { useEffect, useRef, useState } from "react";
import type { RecipeSnapshot } from "../../../server/types.ts";
import { ago, checkedAgo, shortDate } from "../format.ts";
import type { UpstreamStatus } from "../../../server/types.ts";

export async function act(id: string, op: "start" | "stop" | "check" | "update" | "switch"): Promise<string> {
  try {
    const res = await fetch(`/api/recipes/${id}/${op}`, { method: "POST", headers: { "X-Spark-Lens": "1" } });
    const body = (await res.json()) as { message?: string };
    return body.message ?? (res.ok ? "受け付けました" : "操作できませんでした");
  } catch {
    return "サーバーに接続できませんでした";
  }
}

/** Check the upstream now; the refreshed status says the result, so only a failure is returned. */
export async function checkNow(id: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/recipes/${id}/check`, { method: "POST", headers: { "X-Spark-Lens": "1" } });
    const body = (await res.json()) as { ok?: boolean; message?: string };
    return res.ok && body.ok !== false ? null : (body.message ?? "確認できませんでした");
  } catch {
    return "サーバーに接続できませんでした";
  }
}

type Source = "launcher" | "server";

export function LogViewer({ id, hasServerLog, live }: { id: string; hasServerLog: boolean; live: boolean }) {
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
 * Where the checkout stands against its upstream, and the one-click way to
 * follow it (stop, fast-forward, start again).
 */
function Upstream({
  up,
  running,
  canUpdate,
  onCheck,
  onUpdate,
}: {
  up: UpstreamStatus | null;
  running: boolean;
  canUpdate: boolean;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!up) return <p className="upstream upstream--quiet">upstream を確認しています…</p>;
  const head = up.head ? `${up.head}${up.headDate ? ` / ${shortDate(up.headDate)}` : ""}` : "";
  return (
    <div className={`upstream upstream--${up.state}`}>
      <div className="upstream__line">
        <span className="upstream__label">upstream</span>
        {up.repo && up.repoUrl && (
          <a className="upstream__repo" href={up.repoUrl} target="_blank" rel="noopener noreferrer">
            {up.repo}
          </a>
        )}
        <span className="upstream__state">
          {up.state === "current" && `最新です（${head}）`}
          {up.state === "behind" && `${up.behind} 件の更新があります`}
          {up.state === "modified" && `追跡ファイルに手元の変更が ${up.dirtyFiles} 件あります。独自の変更になるため自動では更新しません`}
          {up.state === "untracked" && "追跡するブランチがありません"}
          {up.state === "error" && (up.message ?? "確認できませんでした")}
          {up.state === "unknown" && "未確認"}
        </span>
        <span className="upstream__checked">{checkedAgo(up.checkedAt, Date.now())}</span>
        <button type="button" className="link-button" onClick={onCheck}>
          今すぐ確認
        </button>
        {up.state === "behind" &&
          (confirming ? (
            <span className="upstream__confirm">
              {running ? "停止 → 取り込み → 起動し直します。" : "取り込みます。"}
              <button type="button" className="btn btn--primary" onClick={() => (setConfirming(false), onUpdate())}>
                {running ? "更新して再起動" : "更新する"}
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                やめる
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn--primary btn--small" disabled={!canUpdate} onClick={() => setConfirming(true)}>
              {running ? "更新して再起動" : "更新する"}
            </button>
          ))}
      </div>
      {up.state === "behind" && up.commits.length > 0 && (
        <ul className="upstream__commits">
          {up.commits.slice(0, 4).map((c) => (
            <li key={c.sha}>
              <span>{c.subject}</span>
              <span>{c.date ? shortDate(c.date) : c.sha}</span>
            </li>
          ))}
          {up.commits.length > 4 && <li className="muted">ほか {up.commits.length - 4} 件</li>}
        </ul>
      )}
      {up.newEnvKeys.length > 0 && (
        <p className="upstream__env">
          upstream の設定例に、.env にない項目があります（既定値で動きます）: {up.newEnvKeys.join("、")}
        </p>
      )}
      {up.message && up.state !== "error" && <p className="upstream__env">{up.message}</p>}
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
  const live = recipe.status === "starting" || recipe.status === "stopping" || recipe.status === "updating";
  const last = recipe.lastAction;
  const stopMode = recipe.canStop || recipe.status === "running" || recipe.status === "stopping" || recipe.status === "updating";

  // A fresh message from the server replaces the click acknowledgement.
  useEffect(() => setNotice(null), [last?.message, last?.finishedAt]);

  const run = async (op: "start" | "stop" | "check" | "update") => {
    setConfirming(false);
    setNotice(op === "check" ? await checkNow(recipe.id) : await act(recipe.id, op));
    if (op === "start" || op === "update") setShowLogs(true);
  };

  // While starting, the progress bar says it all.
  const reason =
    recipe.status === "starting"
      ? null
      : recipe.status === "stopping"
        ? "停止処理中です"
        : recipe.status === "updating"
          ? "更新処理中です"
        : recipe.blockedBy
          ? `${recipe.blockedBy} が同じマシンで動いています。先にそちらを停止してください`
          : null;

  return (
    <div className="recipe">
      <div className="recipe__bar">
        {showName && <span className="recipe__name">{recipe.label}</span>}
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
            {recipe.status === "stopping" ? "停止中…" : recipe.status === "updating" ? "更新中…" : "停止する"}
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
      <Upstream
        up={recipe.upstream}
        running={recipe.status === "running" || recipe.status === "starting"}
        canUpdate={recipe.canUpdate}
        onCheck={() => void run("check")}
        onUpdate={() => void run("update")}
      />
      {showLogs && <LogViewer id={recipe.id} hasServerLog={recipe.hasServerLog} live={live} />}
    </div>
  );
}
