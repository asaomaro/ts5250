/**
 * **プリンターと待ち行列の一覧。定義が行で、実行状態を添える。**
 *
 * ## なぜ「実行中の列挙」では足りないか（`20260801-definition-based-listing`）
 *
 * **サービス ✅ ＋ 自動で待ち受け開始 ☐** の定義は、サーバー起動直後は何も動いていない。
 * 実行中だけを並べると**画面に出ないので「開始」を押せず、永久に起動できない**。
 * だから**定義を行にして、動いていなければ `stopped` として出す**。
 *
 * ## なぜブラウザ抜きで見えないと困るか
 *
 * 常駐にすると「ブラウザが居ない時間」が普通になる。自動出力の失敗は
 * `outputWarnings` に溜まるだけで、**誰も見ないまま溜まる**——
 * `20260801-printer-session-residency` で挙げた問題そのもの。
 *
 * ## 信頼境界
 *
 * **信頼設定の中身は出さない**——`autoPdfDir` のパスも `autoPrint` のプリンター名も、
 * 「持っているか（`hasOutput`）」に畳む。警告文にはパスが載りうるので、
 * 一覧そのものを所有で絞る（`listSessions` / `listPrinters` / `WatchRegistry.list`）。
 * **ルート側に認可の条件分岐を書かない**——散らすと食い違う。
 *
 * ## 直接接続は出さない
 *
 * 定義を持たない（ブラウザが host を直指定した）プリンターは、
 * 画面のセッションタブが持つもので**サービスの一覧ではない**。
 */
import type { Hono } from "hono";
import type { AuthVars } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";
import type { SessionManager } from "./session-manager.js";
import type { WatchRegistry } from "./watch-registry.js";
import type { ServiceState } from "./service-state.js";

export interface HostServicesDeps {
  resolver: ConfigResolver;
  sessions: SessionManager;
  watches?: WatchRegistry;
}

/** 一覧 1 行に共通する部分（プリンターと待ち行列で同じ形にする） */
interface ServiceRow {
  /** 定義の参照（`srv:` / `own:`）。**行の同一性はこれ** */
  ref: string;
  name: string;
  /** 待ち受けの状態。**一度も開いていない定義は `stopped`** */
  state: ServiceState;
  /** `state === "error"` のときの理由 */
  error?: string;
  /** サービスとして常駐する定義か */
  service: boolean;
  /** 開いた直後／起動直後に待ち受けを始める定義か（未設定は true） */
  autoStart: boolean;
  /** 動いている実体の id（動いていなければ無い） */
  id?: string;
  owner?: string;
}

export interface PrinterRow extends ServiceRow {
  /** 自動出力の設定を持つか。**中身（パス・プリンター名）は出さない** */
  hasOutput: boolean;
  /** 自動出力の実行時 有効/無効（動いているときだけ） */
  outputEnabled?: boolean;
  /** 累計受信数（**バッファから落ちた分も含む**） */
  receivedTotal?: number;
  /** いま保持している帳票の数（上限で古いものから落ちる） */
  buffered?: number;
  /** 直近の出力警告（**新しい順**）。溜まった古い失敗より、いま起きていることを先に */
  warnings?: { at: number; message: string }[];
}

export interface WatchRow extends ServiceRow {
  /** 監視対象（`ライブラリー/キュー`） */
  label?: string;
  /** 累計受信件数 */
  received?: number;
  /** いま履歴に残っている件数 */
  buffered?: number;
}

export function registerHostPrinterRoutes(app: Hono<{ Variables: AuthVars }>, deps: HostServicesDeps): void {
  app.get("/api/printers", (c) => {
    const user = c.get("user");
    // **定義が行。** 動いているものは後から突き合わせる
    const defs = deps.resolver.listSessions(user).filter((s) => s.sessionType === "printer");
    const running = deps.sessions.listPrinters(user);
    const printers: PrinterRow[] = defs.map((d) => {
      const e = running.find((x) => x.ref === d.ref);
      const row: PrinterRow = {
        ref: d.ref,
        name: d.name,
        // 動いていなければ `stopped`——**定義はあるが待ち受けていない**
        state: e?.state ?? "stopped",
        service: d.service === true,
        autoStart: d.autoStart !== false,
        hasOutput: d.hasOutput === true,
        ...(d.owner !== undefined ? { owner: d.owner } : {})
      };
      if (e) {
        row.id = e.id;
        if (e.error !== undefined) row.error = e.error;
        row.outputEnabled = e.outputEnabled;
        row.receivedTotal = e.receivedTotal;
        row.buffered = e.reports.length;
        row.warnings = [...e.outputWarnings].reverse();
      }
      return row;
    });
    return c.json({ printers });
  });

  app.get("/api/watches", (c) => {
    const user = c.get("user");
    const defs = deps.resolver.listSessions(user).filter((s) => s.sessionType === "dtaqwatch");
    const running = deps.watches?.list(user) ?? [];
    const watches: WatchRow[] = defs.map((d) => {
      const w = running.find((x) => x.ref === d.ref);
      const row: WatchRow = {
        ref: d.ref,
        name: d.name,
        state: w?.state ?? "stopped",
        // **待ち行列は種別そのものがサービス型**（`config-types.ts`）なので常に true
        service: true,
        autoStart: d.autoStart !== false,
        ...(d.owner !== undefined ? { owner: d.owner } : {})
      };
      if (w) {
        row.id = w.id;
        if (w.error !== undefined) row.error = w.error;
        row.label = w.label;
        row.received = w.received;
        // **本文は載せない**——件数だけ（中身は WS の `watch-history` が返す）
        row.buffered = deps.watches?.history(w.id, user).length ?? 0;
      }
      return row;
    });
    return c.json({ watches });
  });
}
