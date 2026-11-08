import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseConfig } from "./config.ts";
import type { Config, SubscriptionConfig } from "./types.ts";

export type ManageKind = "hosts" | "subscriptions";
export type ManageAction = "add" | "remove" | "update";
const BUILTIN = new Set(["claude-code", "codex", "opencode-go", "grok"]);

/** Keep legacy implicit ids stable as entries are removed or reordered. */
function stableSubscriptions(subs: SubscriptionConfig[]): SubscriptionConfig[] {
  const occurrences = new Map<string, number>();
  return subs.map((s) => {
    const n = (occurrences.get(s.type) ?? 0) + 1;
    occurrences.set(s.type, n);
    return { ...s, id: s.id ?? (n === 1 ? s.type : `${s.type}-${n}`) };
  });
}

/** Persist only the edited collection. Never expose credentials or execute user-provided commands. */
export function manageConfig(path: string, current: Config, kind: ManageKind, action: ManageAction, input: Record<string, unknown>): Config {
  if (kind !== "hosts" && kind !== "subscriptions") throw new Error("管理対象が不正です");
  if (action !== "add" && action !== "remove" && action !== "update") throw new Error("操作が不正です");
  const id = input.id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("IDは英小文字・数字・ハイフンで指定してください");
  let base: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { base = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; }
    catch { throw new Error("設定ファイルを読み取れません。JSON形式を確認してください"); }
    const onDisk = parseConfig(base);
    if (JSON.stringify(onDisk) !== JSON.stringify(current)) {
      throw new Error("設定ファイルが外部で変更されています。変更の競合を防ぐため、サーバー再起動後に操作してください");
    }
  }
  const beforeHosts = current.hosts.map((h) => ({ ...h }));
  const beforeSubs = stableSubscriptions(current.subscriptions);
  if (kind === "hosts") {
    if (action === "update") {
      const index = beforeHosts.findIndex((h) => h.id === id);
      if (index === -1) throw new Error("指定ノードが見つかりません");
      const currentHost = beforeHosts[index]!;
      const role = input.role;
      if (role !== "head" && role !== "worker" && role !== "standalone") throw new Error("ノードの役割が不正です");
      if (currentHost.kind !== "spark" && role !== "standalone") throw new Error("Head/WorkerはSparkノードだけに設定できます");
      const headId = role === "worker" ? input.headId : undefined;
      if (role === "worker" && (typeof headId !== "string" || headId === id)) throw new Error("Workerには別のHeadノードが必要です");
      beforeHosts[index] = { ...currentHost, role, headId: typeof headId === "string" ? headId : undefined };
    } else if (action === "add") {
      if (beforeHosts.some((h) => h.id === id)) throw new Error("このノードIDは既に登録されています");
      const label = input.label;
      const ssh = input.ssh;
      const machineKind = input.kind;
      if (typeof label !== "string" || label.trim() === "" || label.length > 80) throw new Error("表示名は1〜80文字で入力してください");
      if (typeof ssh !== "string" || ssh.trim() === "") throw new Error("SSH接続先を指定してください");
      if (machineKind !== "spark" && machineKind !== "workstation" && machineKind !== "server") throw new Error("ノードの種類が不正です");
      const role = input.role ?? "standalone";
      if (role !== "head" && role !== "worker" && role !== "standalone") throw new Error("役割が不正です");
      const headId = role === "worker" ? input.headId : undefined;
      beforeHosts.push({ id, label: label.trim(), kind: machineKind, ssh, role, headId: typeof headId === "string" ? headId : undefined });
    } else {
      const target = beforeHosts.find((h) => h.id === id);
      if (!target) throw new Error("指定ノードが見つかりません");
      if (target.local) throw new Error("監視元のローカルノードは削除できません");
      if (current.llms.some((l) => l.nodes?.includes(id)) || current.recipes.some((r) => r.host === id) || current.hosts.some((h) => h.headId === id)) {
        throw new Error("このノードを参照しているモデル・レシピがあります。先に依存設定を変更してください");
      }
      beforeHosts.splice(beforeHosts.findIndex((h) => h.id === id), 1);
    }
    base.hosts = beforeHosts;
  } else {
    if (action === "update") throw new Error("クラウド枠の更新操作は対応していません");
    if (action === "add") {
      const type = input.type;
      if (typeof type !== "string" || !BUILTIN.has(type)) throw new Error("画面から追加できるのは組み込みプロバイダだけです");
      if (beforeSubs.some((s) => s.id === id || s.type === type)) throw new Error("このプロバイダは既に登録されています");
      if (id !== type) throw new Error("組み込みプロバイダのIDが不正です");
      beforeSubs.push({ id, type });
    } else {
      const i = beforeSubs.findIndex((s) => s.id === id);
      if (i === -1) throw new Error("指定プロバイダが見つかりません");
      beforeSubs.splice(i, 1);
    }
    base.subscriptions = beforeSubs;
  }
  // Canonicalize both collections on first edit so the persisted ids do not
  // shift on a later deletion, including legacy duplicate custom providers.
  base.subscriptions = stableSubscriptions((base.subscriptions ?? beforeSubs) as SubscriptionConfig[]);
  const next = parseConfig(base);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return next;
}
