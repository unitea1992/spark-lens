import type { Snapshot } from "../../../server/types.ts";
import { ModelUsage } from "../components/ModelUsage.tsx";
import { SubscriptionCard } from "../components/SubscriptionCard.tsx";

export function UsagePage({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  return (
    <>
      <section aria-labelledby="h-subs">
        <h2 id="h-subs">クラウド利用枠</h2>
        {snapshot.subscriptions.some((x) => x.windows.length > 0) && (
          <p className="section__hint">
            <span className="tick" aria-hidden="true" />
            縦線は期間の経過位置、薄い帯はこのペースで使い続けた場合の期間終了時の見込みです。
          </p>
        )}
        {snapshot.subscriptions.length === 0 ? (
          <div className="card empty">
            <p>表示するサービスが設定されていません。</p>
            <p className="muted">設定ファイルの subscriptions に追加すると、ここに利用枠が並びます。</p>
          </div>
        ) : (
          <div className="grid grid--subs">
            {snapshot.subscriptions.map((s) => (
              <SubscriptionCard key={s.id} sub={s} now={now} />
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="h-models">
        <h2 id="h-models">モデル別の利用量</h2>
        <ModelUsage usage={snapshot.usage} />
      </section>
    </>
  );
}
