/**
 * **定義の変更を動いているサービスに反映する**（`20260801-service-reconcile`）。
 *
 * `20260801-boot-autostart`（#257）は**起動時に 1 回だけ**定義を読む。そのため
 * 定義を足しても再起動まで上がらず、消しても動き続け、直しても**古い設定のまま**だった。
 * 一覧（#259）には定義が出るので、「自動」と書いてあるのに上がっていない、という
 * **画面と実体の食い違い**が起きる。
 *
 * ## 何をするか
 *
 * | 変更 | 振る舞い |
 * |---|---|
 * | 作成（サービス ✅ ＋ 自動 ✅） | **立ち上げる** |
 * | 削除 | **止めて実体ごと捨てる**（定義が無いのに動き続けるのは筋が通らない） |
 * | サービス ☐ に変更 | **止める**（常駐の意図が取り消された） |
 * | 接続設定の変更 | **止めない**。次に開始したとき効くよう**開き直しの材料だけ差し替える** |
 *
 * ## なぜ設定変更で止めないのか
 *
 * 動いているプリンターを落とすと、その瞬間に流れている帳票の受け取りが切れる。
 * 名前の打ち間違いを直しただけで業務が止まるのは割に合わない。
 *
 * 代わりに `stale` を立てて画面に出す——**「直したのに効いていない」を黙らせない**のが要点で、
 * 反映するかどうか（＝いつ止めてよいか）は利用者が決める。
 *
 * ## 失敗しても呼び出し元を巻き添えにしない
 *
 * これは**設定の保存が終わったあとの後始末**である。ここで投げると、保存は成功したのに
 * API が 500 を返す——利用者から見て「保存できたのか分からない」が一番困る。
 */
import type { ConfigResolver } from "./config-resolver.js";
import type { SessionManager } from "./session-manager.js";
import type { WatchRegistry } from "./watch-registry.js";
import { sessionDtaqWatch } from "./config-types.js";
import { makeWatchSink } from "./webhook-sink.js";
import { childLog } from "./log.js";

const log = childLog({ component: "service-reconcile" });

export interface ServiceReconcileDeps {
  resolver: ConfigResolver;
  sessions: SessionManager;
  watches?: WatchRegistry;
}

/** 定義に起きたこと。`removed` は解決できないので、他と分けて扱う必要がある */
export type SessionChange = "saved" | "removed";

export interface ReconcileResult {
  /** 立ち上げた */
  started?: boolean;
  /** 止めた（サービス ☐ になった・消された） */
  stopped?: boolean;
  /** 動いたまま設定だけ差し替えた（**反映には開始し直しが要る**） */
  stale?: boolean;
  /** 何もしなかった理由（対象外・失敗）。**投げずに残す** */
  skipped?: string;
}

/**
 * 1 つの定義について、動いている実体を定義に合わせる。
 *
 * **決して投げない。** 呼び出し元は設定の保存経路で、そこを巻き添えにしない。
 */
export async function reconcileService(
  deps: ServiceReconcileDeps,
  ref: string,
  change: SessionChange
): Promise<ReconcileResult> {
  try {
    return change === "removed" ? removeService(deps, ref) : await saveService(deps, ref);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn({ ref }, `定義の反映に失敗した: ${message}`);
    return { skipped: message };
  }
}

/** 定義が消えた。**動いているものは止めて捨てる**——定義の無いサービスは残さない */
function removeService(deps: ServiceReconcileDeps, ref: string): ReconcileResult {
  const printer = deps.sessions.listPrinters().find((e) => e.ref === ref);
  if (printer) {
    deps.sessions.stopPrinter(printer.id);
    void deps.sessions.close(printer.id).catch(() => undefined);
    log.info({ ref }, "定義が消えたのでサービスを止めた");
    return { stopped: true };
  }
  const watch = deps.watches?.list().find((w) => w.ref === ref);
  if (watch) {
    deps.watches!.stop(watch.id);
    deps.watches!.remove(watch.id);
    log.info({ ref }, "定義が消えたので監視を止めた");
    return { stopped: true };
  }
  return { skipped: "動いていない" };
}

async function saveService(deps: ServiceReconcileDeps, ref: string): Promise<ReconcileResult> {
  // **個人設定は扱わない。** 起動時の自動開始（#257）と同じ線引き——
  // 所有者のものなので、本人が居ないところでその人として繋ぎに行かない
  if (!ref.startsWith("srv:")) return { skipped: "個人設定" };
  const t = deps.resolver.resolve({ session: ref }, undefined, (m) => log.warn(m));
  const session = t.session;
  if (!session) return { skipped: "セッション設定ではない" };

  if (session.sessionType === "printer") return await savePrinter(deps, ref, t);
  if (session.sessionType === "dtaqwatch") return await saveWatch(deps, ref, t);
  return { skipped: "サービスの種別ではない" };
}

type Resolved = ReturnType<ConfigResolver["resolve"]>;

async function savePrinter(
  deps: ServiceReconcileDeps,
  ref: string,
  t: Resolved
): Promise<ReconcileResult> {
  const entry = deps.sessions.listPrinters().find((e) => e.ref === ref);
  if (!t.service) {
    // **常駐の意図が取り消された。** 動いていれば止める——
    // 「サービスとして使う」の ☐ が効かないなら、その ✅ は何も意味しない
    if (entry) {
      deps.sessions.stopPrinter(entry.id);
      void deps.sessions.close(entry.id).catch(() => undefined);
      log.info({ ref }, "サービス ☐ になったので止めた");
      return { stopped: true };
    }
    return { skipped: "サービスではない" };
  }
  const openOpts = {
    ...t.connect,
    ref,
    origin: "profile" as const,
    service: true,
    ...(t.printerOutput ? { output: t.printerOutput } : {})
  };
  if (!entry) {
    // **先に登録して、それから開始する。** `openPrinter` に任せて開始まで行わせると、
    // 繋がらなかったときに**実体が残らない**——一覧には「未起動」とだけ出て、
    // 理由（装置が使用中・TLS の設定違い・ホスト不達）がサーバーログにしか無い。
    // 「設定したのに動かない」が画面から追えないのは、この機能で一番困る壊れ方
    const created = await deps.sessions.openPrinter({ ...openOpts, autoStart: false });
    if (!t.autoStart) {
      log.info({ ref }, "定義からサービスを登録した（自動で待ち受け開始 ☐）");
      return { started: false };
    }
    await deps.sessions.startPrinter(created.id); // 失敗しても `error` 状態が実体に残る
    log.info({ ref }, "定義からサービスを立ち上げた");
    return { started: true };
  }
  // **動いているものは落とさない。** 次に開始したとき効くよう材料だけ差し替え、
  // いま繋がっているなら「まだ効いていない」ことを画面に出す
  const running = deps.sessions.updatePrinterOptions(entry.id, openOpts);
  if (running) log.info({ ref }, "設定を差し替えた（反映には開始し直しが要る）");
  return running ? { stale: true } : {};
}

async function saveWatch(deps: ServiceReconcileDeps, ref: string, t: Resolved): Promise<ReconcileResult> {
  if (!deps.watches) return { skipped: "監視レジストリが無い" };
  const spec = t.session ? sessionDtaqWatch(t.session) : undefined;
  if (!spec) return { skipped: "監視の設定を持っていない" };
  const label = `${spec.library}/${spec.name}`;
  const sink = makeWatchSink(ref, t.webhook);
  const view = deps.watches.list().find((w) => w.ref === ref);
  if (!view) {
    // 待ち行列は**種別そのものがサービス型**なので `service` を見ない（#257 と同じ）
    if (!t.autoStart) return { skipped: "自動で待ち受け開始 ☐" };
    await deps.watches.start({ ref, label, spec, connect: t.connect, ...(sink ? { sink } : {}) });
    log.info({ ref, label }, "定義から監視を立ち上げた");
    return { started: true };
  }
  const running = deps.watches.update(view.id, {
    label,
    spec,
    connect: t.connect,
    ...(sink ? { sink } : {})
  });
  if (running) log.info({ ref }, "設定を差し替えた（反映には開始し直しが要る）");
  return running ? { stale: true } : {};
}
