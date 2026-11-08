import { useState, type FormEvent } from "react";
import type { HostSnapshot, SubscriptionSnapshot } from "../../../server/types.ts";

const PROVIDERS = [
  { type: "claude-code", label: "Claude Code" },
  { type: "codex", label: "Codex" },
  { type: "opencode-go", label: "OpenCode Go" },
  { type: "grok", label: "Grok" },
];

type Collection = "hosts" | "subscriptions";

function useManage(collection: Collection) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState(false);
  async function submit(payload: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/manage/${collection}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-spark-lens": "1" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as { ok?: boolean; message?: string };
      setError(!response.ok || !body.ok);
      setMessage(body.message ?? (response.ok ? "監視対象を更新しました" : "操作に失敗しました"));
      return response.ok && body.ok === true;
    } catch {
      setError(true);
      setMessage("サーバーに接続できませんでした");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, error, submit };
}

function Feedback({ message, error }: { message: string | null; error: boolean }) {
  return message ? <p role="status" className={`notice${error ? " notice--warn" : ""}`}>{message}</p> : null;
}

export function HostEditor({ hosts }: { hosts: HostSnapshot[] }) {
  const { busy, message, error, submit } = useManage("hosts");
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [ssh, setSsh] = useState("");
  const [kind, setKind] = useState<"server" | "workstation" | "spark">("server");
  const [role, setRole] = useState<"standalone" | "head" | "worker">("standalone");
  const [headId, setHeadId] = useState("");
  const heads = hosts.filter((h) => h.kind === "spark" && h.role === "head");
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await submit({ action: "add", id, label, ssh, kind, role: kind === "spark" ? role : "standalone", headId: kind === "spark" && role === "worker" ? (headId || heads[0]?.id) : undefined })) {
      setId(""); setLabel(""); setSsh("");
    }
  }
  async function remove(host: HostSnapshot) {
    if (!window.confirm(`${host.label} の監視登録を解除しますか？ マシン自体の停止・削除はしません。`)) return;
    await submit({ action: "remove", id: host.id });
  }
  return (
    <details className="monitor-editor">
      <summary>監視ノードを編集</summary>
      <div className="monitor-editor__body">
        <ul className="monitor-editor__list">
          {hosts.map((h) => <li key={h.id}>
            <span><strong>{h.label}</strong> <small>{h.id}{h.local ? " / ローカル" : ""}</small>
              {h.kind === "spark" && <>
                <select aria-label={`${h.label}の役割`} disabled={busy} value={h.role ?? "standalone"}
                  onChange={(e) => { const newRole = e.target.value; void submit({ action: "update", id: h.id, role: newRole, headId: newRole === "worker" ? (h.headId ?? heads.find((x) => x.id !== h.id)?.id) : undefined }); }}>
                  <option value="standalone">Standalone</option><option value="head">Head</option>
                  <option value="worker" disabled={heads.every((x) => x.id === h.id)}>Worker</option>
                </select>
                {h.role === "worker" && <select aria-label={`${h.label}のHead`} disabled={busy} value={h.headId ?? ""}
                  onChange={(e) => void submit({ action: "update", id: h.id, role: "worker", headId: e.target.value })}>
                  {heads.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>}
              </>}
            </span>
            <button type="button" disabled={busy || h.local === true} onClick={() => void remove(h)} aria-label={`${h.label}の監視登録を解除`}>解除</button>
          </li>)}
        </ul>
        <form className="monitor-editor__form" onSubmit={(e) => void add(e)}>
          <label>ノードID <input required value={id} onChange={(e) => setId(e.target.value)} placeholder="worker-2" pattern="[a-z0-9][a-z0-9-]*" /></label>
          <label>表示名 <input required maxLength={80} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="追加サーバー" /></label>
          <label>SSH接続先 <input required value={ssh} onChange={(e) => setSsh(e.target.value)} placeholder="ssh-configの接続名" /></label>
          <label>種類 <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="server">サーバー</option><option value="workstation">開発機</option><option value="spark">Spark</option>
          </select></label>
          {kind === "spark" && <label>役割 <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
            <option value="standalone">Standalone</option><option value="head">Head</option>
            <option value="worker" disabled={heads.length === 0}>Worker</option>
          </select></label>}
          {kind === "spark" && role === "worker" && <label>Head <select value={headId || heads[0]?.id || ""} onChange={(e) => setHeadId(e.target.value)}>
            {heads.map((h) => <option key={h.id} value={h.id}>{h.label}</option>)}
          </select></label>}
          <button type="submit" disabled={busy}>ノードを追加（SSH接続を検証）</button>
        </form>
        <p className="muted">追加時にSSHで読み取り専用の接続確認を行います。接続設定は事前に開発機側で用意してください。モデルやレシピが参照するノードは先に依存設定を変更する必要があります。</p>
        <Feedback message={message} error={error} />
      </div>
    </details>
  );
}

export function SubscriptionEditor({ subscriptions }: { subscriptions: SubscriptionSnapshot[] }) {
  const { busy, message, error, submit } = useManage("subscriptions");
  const available = PROVIDERS.filter((p) => !subscriptions.some((s) => s.type === p.type));
  const [selected, setSelected] = useState("claude-code");
  async function remove(s: SubscriptionSnapshot) {
    if (!window.confirm(`${s.label} の利用枠監視を解除しますか？ 認証情報は削除されません。`)) return;
    await submit({ action: "remove", id: s.id });
  }
  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const type = available.some((p) => p.type === selected) ? selected : available[0]?.type;
    if (type) void submit({ action: "add", id: type, type });
  }
  return (
    <details className="monitor-editor">
      <summary>クラウド枠の監視対象を編集</summary>
      <div className="monitor-editor__body">
        <ul className="monitor-editor__list">
          {subscriptions.map((s) => <li key={s.id}>
            <span><strong>{s.label}</strong> <small>{s.id}</small></span>
            <button type="button" disabled={busy} onClick={() => void remove(s)} aria-label={`${s.label}の利用枠監視を解除`}>解除</button>
          </li>)}
        </ul>
        {available.length > 0 && <form className="monitor-editor__form" onSubmit={add}>
          <label>サービス <select value={available.some((p) => p.type === selected) ? selected : available[0]!.type} onChange={(e) => setSelected(e.target.value)}>
            {available.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
          </select></label>
          <button type="submit" disabled={busy}>監視を追加</button>
        </form>}
        <p className="muted">追加可能なのは組み込みサービスです。独自の取得スクリプトは従来どおり設定ファイルで管理できます。</p>
        <Feedback message={message} error={error} />
      </div>
    </details>
  );
}
