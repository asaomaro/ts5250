/**
 * **サーバー起動時にサービスを立ち上げる**（`20260801-boot-autostart`）。
 *
 * ここが入って初めて「サーバー」になる。これまでは
 * `20260801-printer-session-residency` が「**一度開いたら残る**」を、
 * `20260801-service-start-stop` が「開始/停止」を実現していたが、
 * **プロセスを再起動すると何も動いていない**状態だった。
 *
 * ## 立ち上げる範囲
 *
 * **サーバー設定（`profiles.json`）の定義だけ。**
 *
 * 個人設定（`connections.json`）は所有者のものなので、**本人が居ない起動時に
 * その人として繋ぎに行かない**。サービスは共有の設備であり、
 * プリンターの `service` は元々サーバー設定側のスキーマにしか無い。
 *
 * ## 失敗しても起動を止めない
 *
 * ホストが落ちている・資格情報が無い定義があっても、**サーバーは上がる**。
 * 失敗は `error` 状態としてエントリに残るので、
 * 一覧（`GET /api/printers` / `/api/watches`）に出て画面から気づける。
 * **例外で起動を巻き添えにしない**のが要点——1 台の設定ミスで全部が止まるのは割に合わない。
 */
import { As400Error } from "@ts5250/base";
import type { ConfigResolver } from "./config-resolver.js";
import type { SessionManager } from "./session-manager.js";
import type { WatchRegistry } from "./watch-registry.js";
import { sessionDtaqWatch } from "./config-types.js";
import { makeWatchSink } from "./webhook-sink.js";
import { childLog } from "./log.js";

const log = childLog({ component: "boot-autostart" });

export interface BootAutoStartDeps {
  resolver: ConfigResolver;
  sessions: SessionManager;
  watches?: WatchRegistry;
}

export interface BootAutoStartResult {
  /** 立ち上げた数 */
  started: number;
  /** 失敗した定義（`ref` と理由）。**起動は止めない** */
  failed: { ref: string; error: string }[];
  /** 対象外として飛ばした数（サービスでない・自動開始 ☐・個人設定） */
  skipped: number;
}

/**
 * 定義を読んでサービスを立ち上げる。**サーバーが待ち受けを始めた後に呼ぶ**
 * （繋ぎに行くのに時間がかかるので、HTTP の口を開けるのを待たせない）。
 */
export async function startAutoServices(deps: BootAutoStartDeps): Promise<BootAutoStartResult> {
  const result: BootAutoStartResult = { started: 0, failed: [], skipped: 0 };
  // **user を渡さない＝認証オフ相当で全部見える。** ここはサーバー自身の起動処理で、
  // 誰かの代理ではない。個人設定は下で `srv:` に絞って除く
  const defs = deps.resolver.listSessions(undefined);

  for (const d of defs) {
    // **サーバー設定だけ。** 個人設定は所有者のものなので、本人が居ない起動時に繋がない
    if (!d.ref.startsWith("srv:")) {
      result.skipped++;
      continue;
    }
    // **自動で待ち受け開始 ☐ は上げない**（利用者が開始ボタンを押すまで待つ）
    if (d.autoStart === false) {
      result.skipped++;
      continue;
    }
    try {
      if (d.sessionType === "printer") {
        // **サービス ✅ でないプリンターは上げない**——対話型は人が開くもの
        if (d.service !== true) {
          result.skipped++;
          continue;
        }
        await startPrinter(deps, d.ref);
        result.started++;
      } else if (d.sessionType === "dtaqwatch") {
        // 待ち行列は**種別そのものがサービス型**なので `service` を見ない
        if (!deps.watches) {
          result.skipped++;
          continue;
        }
        await startWatch(deps, d.ref);
        result.started++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      // **1 台の失敗で全部を止めない。** 状態は `error` としてエントリに残り、
      // 一覧に出るので画面から気づける
      const message = e instanceof Error ? e.message : String(e);
      result.failed.push({ ref: d.ref, error: message });
      log.warn({ ref: d.ref }, `自動開始に失敗した: ${message}`);
    }
  }

  if (result.started || result.failed.length) {
    log.info(result, "サービスの自動開始が終わった");
  }
  return result;
}

async function startPrinter(deps: BootAutoStartDeps, ref: string): Promise<void> {
  const t = deps.resolver.resolve({ session: ref }, undefined, (m) => log.warn(m));
  await deps.sessions.openPrinter({
    ...t.connect,
    ref,
    origin: "profile",
    service: true,
    ...(t.printerOutput ? { output: t.printerOutput } : {})
  });
}

async function startWatch(deps: BootAutoStartDeps, ref: string): Promise<void> {
  const t = deps.resolver.resolve({ session: ref }, undefined, (m) => log.warn(m));
  const spec = t.session ? sessionDtaqWatch(t.session) : undefined;
  if (!spec) {
    throw new As400Error("CONFIG_ERROR", `${ref} は監視の設定を持っていません`);
  }
  const sink = makeWatchSink(ref, t.webhook);
  await deps.watches!.start({
    ref,
    label: `${spec.library}/${spec.name}`,
    spec,
    connect: t.connect,
    ...(sink ? { sink } : {})
  });
}
