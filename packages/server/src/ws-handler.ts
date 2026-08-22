import { As400Error } from "@ts5250/base";
import { type AidKey, type ScreenSnapshot } from "@ts5250/tn5250";
import { childLog } from "./log.js";
import {
  SessionManager,
  type OpenOptions,
  type SessionEntry,
  type SessionTarget,
  type StoredReport
} from "./session-manager.js";
import type { WatchRegistry } from "./watch-registry.js";
import { sessionWatch } from "./config-types.js";
import { makeWatchSink } from "./webhook-sink.js";
import type { AuthUser } from "./auth.js";
import type { ConfigResolver, ResolvedTarget } from "./config-resolver.js";
import { withAudit } from "./audit.js";
import type { SpoolReportMsg, WsClientMessage, WsFieldRef, WsKeyField, WsServerMessage } from "./ws-messages.js";
import type { MacroStore } from "./macro-store.js";
import type { Tn3270Manager } from "./tn3270-manager.js";
import { applyFields, planKey3270, toWireScreen } from "./tn3270-adapt.js";
import type { VtManager } from "./vt-manager.js";
import { VtFrameBuilder, type WsVtFrame } from "./vt-wire.js";
import type { VtKeyName, VtEncoding } from "@ts5250/vt";
import { macroSecretRefSchema } from "./macro-types.js";

const wsLog = childLog({ component: "ws-handler" });

export interface WsHandlerDeps {
  sessions: SessionManager;
  /**
   * サービス型の常駐ジョブ（データ待ち行列の監視）。
   * **WS はここを購読するだけ**で所有しない——`dispose()` はレジストリに触らない
   * （触ると「ブラウザを閉じたら監視が止まる」になり要件を満たさない。research F1）。
   * 未指定なら監視のメッセージは `CONFIG_ERROR` で断る。
   */
  watches?: WatchRegistry;
  /** 接続設定の唯一の解決点（system / session 参照 → 接続オプション） */
  resolver: ConfigResolver;
  /**
   * マクロのストア。**再生時の秘密の解決だけ**に使う（spec D11）。
   * 未指定なら秘密参照を含むキー送信は拒否される（黙って空文字で送らない）。
   */
  macros?: MacroStore;
  /**
   * **3270 端末のセッション**。未指定なら `terminal: "3270"` の `open` を断る。
   * 5250 の `sessions` と**別に持つ**理由は spec D5——`SessionEntry.session` の型を
   * 差し替えずに済ませ、既存経路への影響を切る。
   */
  tn3270?: Tn3270Manager;
  vt?: VtManager;
}

/** 保存済み設定への参照が含まれるか（含まなければブラウザ直指定） */
function hasRef(msg: { system?: string; session?: string }): boolean {
  return Boolean(msg.system ?? msg.session);
}

/** 監査ログに残す出所。セッション参照があればそちらを優先する */
function originOf(msg: { system?: string; session?: string }): string {
  return msg.session ?? msg.system ?? "direct";
}

/**
 * 帳票を電文の形に落とす（`20260802-printer-report-history`）。
 *
 * **live の push（`report`）と開き直しの配り直し（`printer-opened.reports`）で同じ関数を通す。**
 * 片方だけ `receivedAt` を載せると、「開き直すと時刻が出るのに、いま届いたものには無い」
 * という説明しにくい差になる。**生バイト（`raw`）は載せない**——画面は等幅グリッドしか使わない。
 */
function spoolReportMsg(r: StoredReport): SpoolReportMsg {
  return { id: r.id, pages: r.pages, receivedAt: r.receivedAt };
}

/** WSContext の最小インターフェース（@hono/node-server の WSContext / テストのモック双方に適合） */
export interface WsSender {
  send(data: string): void;
  close(): void;
}

/** ハートビート（`ping`）の間隔（ms） */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * 最後にクライアントから何か受け取ってからこの時間を超えたら、半開きと見なして破棄する。
 * 心拍 3 回ぶんの取りこぼしを許す（回線の一時的な詰まりで切らないため）。
 */
export const HEARTBEAT_DEAD_MS = 90_000;

/** ハートビートの調整（テストで間隔と時刻を差し替えるための口） */
export interface HeartbeatOptions {
  intervalMs?: number;
  deadMs?: number;
  now?: () => number;
}

/**
 * 1 WebSocket 接続 = 1 セッションの状態機械（spec「Web 向けプロトコル」）。
 * open/key/jobinfo/close を処理し、session の screen イベントを push する。切断でセッションを破棄する。
 *
 * **寿命の見張りはここが持つ**（`20260729-session-lifetime-timeout`）。セッションのアイドル
 * タイムアウトは既定で永続になったため、孤児を回収するのは
 * ①`onSocketClose`（ブラウザを閉じた）と ②このハートビート（半開きソケット）の 2 つだけ。
 * どちらも WS 前提なので、**WS を持たない MCP 経路は `orphanSafeIdleTimeoutMs` が受け持つ**。
 */
/** 画面がまだ無いときの空フレーム（`vt-opened` は必ず 1 通出す） */
function emptyVtFrame(rows: number, cols: number): WsVtFrame {
  return {
    rows,
    cols,
    cursor: { row: 0, col: 0, visible: true },
    alternate: false,
    title: "",
    styles: [],
    lines: []
  };
}

export class WsConnection {
  private sessionId: string | undefined;
  /**
   * **3270 セッションの id**。`sessionId`（5250）とは別枠にしてある——
   * 同じ枠に入れると、5250 専用の経路（予約・watch・PC コマンド）が
   * 型では通ってしまい、実行時に初めて壊れる。
   */
  private session3270: string | undefined;
  private detach3270: (() => void) | undefined;
  /**
   * **VT セッションの id**。5250 / 3270 とさらに別枠——画面の型も入力の経路も違うので、
   * 同じ枠に入れると 5250 専用の経路が型では通ってしまう（3270 と同じ理由）。
   */
  private sessionVt: string | undefined;
  private detachVt: (() => void) | undefined;
  /** VT の差分を作る器。**接続 1 本につき 1 つ**（前回送った内容を覚えている） */
  private vtFrames: VtFrameBuilder | undefined;
  private detachScreen: (() => void) | undefined;
  /**
   * **このタブが開いたのではなく、既にあるセッションへ繋いだ**か。
   *
   * 切断時にセッションを閉じてよいかの判断に使う。**繋いだだけのタブは閉じない**
   * ——閉じると、開いた人や MCP の作業をこちらの都合で殺すことになる。
   */
  private attached = false;
  private detachReport: (() => void) | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 監視の購読解除。**購読だけを畳む**（監視そのものは止めない） */
  private detachWatch: (() => void) | undefined;
  /** 最後にクライアントから何かを受け取った時刻。**pong 専用にしない**（下記 `handle`） */
  private lastSeen: number;
  private readonly hbIntervalMs: number;
  private readonly hbDeadMs: number;
  private readonly hbNow: () => number;

  constructor(
    private readonly deps: WsHandlerDeps,
    private readonly ws: WsSender,
    private readonly user?: AuthUser,
    hb: HeartbeatOptions = {}
  ) {
    this.hbIntervalMs = hb.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.hbDeadMs = hb.deadMs ?? HEARTBEAT_DEAD_MS;
    this.hbNow = hb.now ?? (() => Date.now());
    this.lastSeen = this.hbNow();
  }

  async handle(raw: string): Promise<void> {
    // **任意の受信で生存を更新する。** pong だけを見ると、キー送信が流れている最中に
    // 心拍が 3 回取りこぼされただけで生きている接続を切ってしまう。
    this.lastSeen = this.hbNow();
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw) as WsClientMessage;
    } catch {
      return this.sendError("PROTOCOL_ERROR", "invalid JSON", false);
    }
    try {
      switch (msg.type) {
        case "open":
          return await this.onOpen(msg);
        case "key":
          return await this.onKey(msg);
        case "vt-input":
          // **VT は打鍵ごとに来る。** 監査には残さない——`text` に打った文字そのものが
          // 入るので、パスワードを打っている最中の中身を記録することになる
          return this.onVtInput(msg);
        case "vt-resize":
          return this.onVtResize(msg);
        case "gui-select":
          return await this.onGuiSelect(msg);
        case "gui-submit":
          return await this.onGuiSubmit(msg);
        case "printer-output":
          return await this.onPrinterOutput(msg);
        case "reserve-break":
          return this.onReserveBreak();
        case "watch-subscribe":
          return this.onWatchSubscribe();
        case "watch-start":
          return await this.onWatchStart(msg);
        case "watch-stop":
          return this.onWatchStop(msg);
        case "watch-resume":
          return await this.onWatchResume(msg);
        case "printer-service-start":
          return await this.onPrinterServiceStart(msg);
        case "printer-start":
          return await this.onPrinterStart(msg);
        case "printer-stop":
          return await this.onPrinterStop(msg);
        case "watch-history":
          return this.onWatchHistory(msg);
        case "activity":
          // 在席の合図。**監査にも操作ログにも残さない**——利用者の意図を含まないうえ、
          // 15 秒間隔で流れるので本来の記録を量で押し流す
          return this.onActivity();
        case "pong":
          return; // 生存の更新は上で済んでいる
        case "close":
          return this.dispose("closed by client");
        default:
          return this.sendError("PROTOCOL_ERROR", `unknown message type`, false);
      }
    } catch (err) {
      const code = err instanceof As400Error ? err.code : "INTERNAL_ERROR";
      // **`fatal` は「この接続にセッションが無い / 失われた」という状態で決める。**
      // 以前はエラーコードの列挙（`SESSION_CLOSED` / `CONNECT_FAILED`）で決めていたが、
      // それだと**コード名を変えた瞬間に意味が黙って変わる**——実際 `open` の失敗が
      // `CONNECT_FAILED` から `CONFIG_ERROR` / `SESSION_LIMIT` へ分かれた時点で、
      // 列挙のままなら「開けなかった」が致命的でなくなっていた
      // （`20260729-connect-failed-semantics` spec 方針3）。
      const fatal = code === "SESSION_CLOSED" || this.sessionId === undefined;
      this.sendError(code, err instanceof Error ? err.message : String(err), fatal);
    }
  }

  /** WebSocket 切断時に呼ぶ（セッションを破棄） */
  onSocketClose(): void {
    this.dispose("websocket closed");
  }

  /**
   * 在席の合図を受けて `lastActivity` を進める。**id はこの接続が開いたものだけ**なので
   * クライアントから受け取らない（所有者検査が要らないのはそのため）。
   * `open` 前に来たら何もしない（`requireSession` で投げると無害な合図で接続が壊れる）。
   */
  private onActivity(): void {
    if (this.sessionId) this.deps.sessions.touch(this.sessionId);
  }

  // ---- 監視（サービス型の常駐ジョブ）----
  //
  // **`open`（5250 セッション）を要さない。** 監視コンソールは pane タブで、
  // セッションを持たないタブだから（research F6）。`requireSession()` を通すと
  // コンソールから一切使えなくなる。

  private requireWatches(): WatchRegistry {
    const w = this.deps.watches;
    if (!w) throw new As400Error("CONFIG_ERROR", "watch registry is not configured");
    return w;
  }

  /** 一覧を配る（購読直後・開始・停止の後に使う） */
  private sendWatchList(): void {
    this.send({ type: "watch-list", watches: this.requireWatches().list(this.user) });
  }

  /**
   * 購読する。**再接続のたびに「今ある監視の一覧」を配り直す**——
   * ブラウザを閉じている間も監視は続いているので、開き直した側は状態を知らない。
   *
   * 併せてハートビートを始める。監視だけの WS はセッションを持たないので
   * `onSocketClose` 以外に死を知る手が無く、半開きのまま push し続けるのを避ける。
   */
  /**
   * 予約を強制的に外す（利用者の非常口）。
   *
   * **自分のセッションにしか効かない**（`forceRelease` が `get` を通す）ので権限の穴にならない。
   * これが無いと、自動化が落ちて `Release` を送れないまま期限（2 分）が切れるのを
   * 待つしかなくなる。
   */
  private onReserveBreak(): void {
    this.deps.sessions.forceRelease(this.requireSession(), this.user);
  }

  private onWatchSubscribe(): void {
    const reg = this.requireWatches();
    this.detachWatch?.(); // 二重購読しない
    // **他人の監視は配らない。** 絞り込みはレジストリに任せる（所有の規則を 2 か所に書かない）
    this.detachWatch = reg.subscribe((ev) => {
      if (ev.type === "list") {
        // 行が増減した（定義が足された・消された）。**状態通知では伝わらない**
        this.sendWatchList();
      } else if (ev.type === "entry") {
        this.send({
          type: "watch-entry",
          watchId: ev.watch.id,
          entry: ev.entry,
          received: ev.watch.received
        });
      } else {
        this.send({
          type: "watch-state",
          watchId: ev.watch.id,
          state: ev.watch.state,
          ...(ev.watch.error !== undefined ? { error: ev.watch.error } : {})
        });
      }
    }, this.user);
    this.startHeartbeat();
    this.sendWatchList();
  }

  /**
   * 保存済みセッション設定から監視を始める。
   *
   * **常駐の対象は保存済み設定だけ**（research F3）——資格情報をサーバー側だけで
   * 解決できるので、ブラウザが居なくても張り直せる。
   */
  /**
   * 待ち受けの開始／停止。**プリンターと監視で同じ操作**（`20260801-service-start-stop`）。
   * どちらも冪等——画面から二重に押されても壊れない。
   */
  private async onPrinterStart(msg: WsClientMessage & { type: "printer-start" }): Promise<void> {
    await withAudit({ op: "ws_printer_start" }, async () => {
      await this.deps.sessions.startPrinter(msg.sessionId, this.user);
    });
  }

  /**
   * **定義からプリンターサービスを立ち上げる**（`20260801-services-pane`）。
   *
   * `openPrinter` は `ref` で既存に繋ぐので、**一度も開いていない定義にも、
   * 停止中の常駐にも同じ 1 通で効く**（前者は作って開始、後者は既存を返すので開始し直す）。
   *
   * **サービス ✅ の定義だけ受ける。** `resolve` が `service` を立てるのは
   * サーバー設定由来のときだけなので、個人設定のプリンターをここから常駐化できない
   * （信頼境界 5 層目。`config-resolver.ts`）。
   */
  private async onPrinterServiceStart(
    msg: WsClientMessage & { type: "printer-service-start" }
  ): Promise<void> {
    await withAudit({ op: "ws_printer_service_start" }, async () => {
      const t = this.deps.resolver.resolve({ session: msg.session }, this.user, (m) => wsLog.warn(m));
      if (!t.service) {
        throw new As400Error(
          "CONFIG_ERROR",
          `${msg.session} は「サービスとして使う」に設定されていません`
        );
      }
      const entry = await this.deps.sessions.openPrinter({
        ...t.connect,
        ref: msg.session,
        origin: "profile",
        service: true,
        // **停止中の常駐に当たったときのため。** `openPrinter` は既存を返して終わるので、
        // ここで開始し直さないと「押しても動かない」になる
        autoStart: false,
        ...(t.printerOutput ? { output: t.printerOutput } : {})
      });
      await this.deps.sessions.startPrinter(entry.id, this.user);
    });
  }

  /**
   * **`void` で捨てない。** 捨てると 2 つ壊れる（認証ありの実機 E2E で踏んだ）:
   *
   * - 拒否（他人のサービスを止めようとした）が**利用者に返らない**——
   *   `handle()` の catch が `error` を送る経路を、`void` が迂回してしまう
   * - 未処理の rejection として**プロセスごと落ちる**
   */
  private async onPrinterStop(msg: WsClientMessage & { type: "printer-stop" }): Promise<void> {
    await withAudit({ op: "ws_printer_stop" }, async () => {
      this.deps.sessions.stopPrinter(msg.sessionId, this.user);
    });
  }

  private async onWatchResume(msg: WsClientMessage & { type: "watch-resume" }): Promise<void> {
    const reg = this.requireWatches();
    await withAudit({ op: "ws_watch_resume" }, async () => {
      await reg.resume(msg.watchId, this.user);
    });
  }

  private async onWatchStart(msg: WsClientMessage & { type: "watch-start" }): Promise<void> {
    const reg = this.requireWatches();
    await withAudit({ op: "ws_watch_start" }, async () => {
      const target = this.deps.resolver.resolve({ session: msg.session }, this.user, (m) => wsLog.warn(m));
      const spec = target.session ? sessionWatch(target.session) : undefined;
      if (!spec) {
        throw new As400Error(
          "CONFIG_ERROR",
          `${msg.session} は待ち受けの設定を持っていません` +
            "（種別 dtaqwatch / msgwatch のセッション設定を指定してください）"
        );
      }
      const sink = makeWatchSink(msg.session, target.webhook);
      await reg.start({
        ref: msg.session,
        label: `${spec.library}/${spec.name}`,
        spec,
        connect: target.connect,
        ...(sink ? { sink } : {}),
        ...(this.user ? { owner: this.user.username } : {})
      });
      this.sendWatchList();
    });
  }

  private onWatchStop(msg: WsClientMessage & { type: "watch-stop" }): void {
    const reg = this.requireWatches();
    reg.stop(msg.watchId, this.user);
    this.sendWatchList();
  }

  private onWatchHistory(msg: WsClientMessage & { type: "watch-history" }): void {
    const reg = this.requireWatches();
    this.send({
      type: "watch-history",
      watchId: msg.watchId,
      entries: reg.history(msg.watchId, this.user)
    });
  }

  /**
   * ハートビートを始める（`open` 成功後。display / printer 共通）。
   *
   * **死判定を ping の送信より先に行う**——送ってから判定すると 1 周期ぶん遅れる。
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.hbNow() - this.lastSeen > this.hbDeadMs) {
        // 半開き（TCP は死んでいるのに close イベントが来ない）。send はローカルで成功するので
        // 送信の失敗では気づけない。ここで自分から畳む
        wsLog.warn({ sessionId: this.sessionId }, "no client response; closing half-open websocket");
        this.dispose("heartbeat timeout");
        this.ws.close();
        return;
      }
      this.send({ type: "ping" });
    }, this.hbIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private async onOpen(msg: WsClientMessage & { type: "open" }): Promise<void> {
    if (this.sessionId ?? this.session3270 ?? this.sessionVt) {
      throw new As400Error("PROTOCOL_ERROR", "session already open on this connection");
    }
    if (msg.kind === "printer") return this.onOpenPrinter(msg);
    if (msg.terminal === "3270") return this.onOpen3270(msg);
    if (msg.terminal === "vt") return this.onOpenVt(msg);
    await withAudit({ op: "ws_open" }, async () => {
      // **既存セッションへ繋ぐ**なら、ここで終わる——新しい接続は作らない
      if (msg.sessionId !== undefined) return this.attach(msg.sessionId);
      // 保存済み設定（system / session）か、ブラウザ直指定か。解決は ConfigResolver に一本化されている
      let opts: OpenOptions;
      if (hasRef(msg)) {
        const target = this.resolveTarget(msg);
        opts = { ...target.connect, origin: originOf(msg), target: this.targetOf(msg) };
        // PC コマンドの実行設定はサーバー設定由来のときだけ入る（信頼境界の 5 層目）。
        // **ブラウザ直指定では絶対に付けない**——任意コマンド実行の入口になる
        if (target.pcCommand) opts.pcCommand = target.pcCommand;
      } else {
        opts = buildDirect(msg);
      }
      if (msg.readOnly) opts.readOnly = true;
      if (this.user) opts.owner = this.user.username;
      const entry = await this.deps.sessions.open(opts);
      this.sessionId = entry.id;
      this.startHeartbeat();
      this.subscribeSession(entry);
      this.send({
        type: "opened",
        sessionId: entry.id,
        screen: entry.session.snapshot(),
        ccsid: opts.ccsid ?? 37,
        pcCommand: entry.pcCommandEnabled,
        // **後から入ったタブにも今の予約状態を伝える**（開始の push を聞き逃していても揃う）
        ...(() => {
          const r = this.deps.sessions.reservationOf(entry.id);
          return r ? { reservedBy: r.label } : {};
        })(),
        // 起動応答で分かる範囲（装置名＝ジョブ名）は接続と同時に出せる
        ...(entry.job !== undefined ? { job: entry.job } : {})
      });
      // ユーザー・番号は背後で引いている。**待たない**——取れたら足すだけ
      void entry.jobResolved?.then((job) => {
        if (job?.user !== undefined && this.sessionId === entry.id) {
          this.send({ type: "jobinfo", job });
        }
      });
    });
  }

  /**
   * **3270 端末のセッションを開く。**
   *
   * 5250 の `onOpen` と分けているのは spec D5——保存済み設定（system / session）の解決や
   * 自動サインオン・予約・ジョブ情報は 5250 の世界のもので、3270 には無い。
   * **ホスト直指定だけ**を受ける（保存済み設定への対応は要求が出てから）。
   */
  private async onOpen3270(msg: WsClientMessage & { type: "open" }): Promise<void> {
    const mgr = this.deps.tn3270;
    if (mgr === undefined) {
      throw new As400Error("CONFIG_ERROR", "3270 terminal is not enabled on this server");
    }
    // **保存済み設定（system / session 参照）でも、ホスト直指定でも開ける。**
    // 解決は 5250 と同じ `ConfigResolver` に通す——接続先と資格情報の決まり方を
    // 端末の種類ごとに分岐させない（信頼境界を二重に書かないため）
    const connect = hasRef(msg) ? this.resolveTarget(msg).connect : undefined;
    const host = connect?.host ?? msg.host;
    if (host === undefined) throw new As400Error("CONFIG_ERROR", "host or profile required");
    await withAudit({ op: "ws_open" }, async () => {
      const port = msg.port ?? connect?.port;
      const ccsid = msg.ccsid ?? connect?.ccsid;
      const tls = msg.tls ?? connect?.tls;
      // **装置名は 5250 と同じ順**（直指定が保存済み設定より優先）。
      // 渡し方（NEW-ENVIRON の DEVNAME か端末タイプの `@名前` か）は telnet 層が決める
      const deviceName = msg.deviceName ?? connect?.deviceName;
      const entry = await mgr.open({
        host,
        ...(port !== undefined ? { port } : {}),
        ...(msg.model !== undefined ? { model: msg.model } : {}),
        ...(ccsid !== undefined ? { ccsid } : {}),
        ...(tls !== undefined ? { tls } : {}),
        ...(deviceName !== undefined ? { deviceName } : {}),
        ...(msg.readOnly !== undefined ? { readOnly: msg.readOnly } : {}),
        ...(this.user !== undefined ? { owner: this.user.username } : {})
      });
      this.session3270 = entry.id;
      this.startHeartbeat();
      const push = (screen: ScreenSnapshot): void => this.send({ type: "screen", screen });
      entry.subscribers.add(push);
      this.detach3270 = () => entry.subscribers.delete(push);
      this.send({
        type: "opened",
        sessionId: entry.id,
        screen: toWireScreen(entry.session, entry.id),
        ccsid: ccsid ?? 37,
        pcCommand: false
      });
    });
  }

  /**
   * **VT のセッションを開く。**
   *
   * 3270 と同じく、保存済み設定（`system` / `session`）もホスト直指定も受ける
   * ——解決は 5250 と同じ `ConfigResolver` に通し、接続先と資格情報の決まり方を
   * 端末の種類ごとに分岐させない。
   *
   * **画面の大きさはブラウザが測って渡す。** VT は 24x80 固定ではなく、
   * ペインの寸法がそのまま `stty size` になる。
   */
  private async onOpenVt(msg: WsClientMessage & { type: "open" }): Promise<void> {
    const mgr = this.deps.vt;
    if (mgr === undefined) {
      throw new As400Error("CONFIG_ERROR", "VT terminal is not enabled on this server");
    }
    const connect = hasRef(msg) ? this.resolveTarget(msg).connect : undefined;
    const host = connect?.host ?? msg.host;
    if (host === undefined) throw new As400Error("CONFIG_ERROR", "host or profile required");
    await withAudit({ op: "ws_open" }, async () => {
      const port = msg.port ?? connect?.port;
      const ccsid = msg.ccsid ?? connect?.ccsid;
      const tls = msg.tls ?? connect?.tls;
      const deviceName = msg.deviceName ?? connect?.deviceName;
      const entry = await mgr.open({
        host,
        ...(port !== undefined ? { port } : {}),
        ...(msg.vtRows !== undefined ? { rows: msg.vtRows } : {}),
        ...(msg.vtCols !== undefined ? { cols: msg.vtCols } : {}),
        ...(msg.encoding !== undefined ? { encoding: msg.encoding as VtEncoding } : {}),
        ...(ccsid !== undefined ? { ccsid } : {}),
        ...(tls !== undefined ? { tls } : {}),
        ...(deviceName !== undefined ? { deviceName } : {}),
        ...(msg.readOnly !== undefined ? { readOnly: msg.readOnly } : {}),
        ...(this.user !== undefined ? { owner: this.user.username } : {})
      });
      this.sessionVt = entry.id;
      this.vtFrames = new VtFrameBuilder();
      this.startHeartbeat();

      // **交渉は開いたあとに終わることがある。** `vt-opened` の時点の値を握ったままにすると
      // 「エコーを返していません」の案内が出たまま残る（実ブラウザ検証で踏んだ）
      let lastEcho = entry.session.hostEchoes;
      const push = (snap: Parameters<Parameters<typeof entry.subscribers.add>[0]>[0]): void => {
        const frame = this.vtFrames?.build(snap);
        const echo = entry.session.hostEchoes;
        const echoChanged = echo !== lastEcho;
        lastEcho = echo;
        // **変化が無ければ送らない**（差分が空の通で回線を埋めない）
        if (frame === undefined) {
          if (echoChanged) this.send({ type: "vt-echo", hostEchoes: echo });
          return;
        }
        this.send({ type: "vt-frame", frame: echoChanged ? { ...frame, hostEchoes: echo } : frame });
      };
      const pushTitle = (title: string): void => this.send({ type: "vt-title", title });
      const pushClose = (reason: string): void => this.send({ type: "closed", reason });
      entry.subscribers.add(push);
      entry.titleSubscribers.add(pushTitle);
      entry.closeSubscribers.add(pushClose);
      this.detachVt = () => {
        entry.subscribers.delete(push);
        entry.titleSubscribers.delete(pushTitle);
        entry.closeSubscribers.delete(pushClose);
      };

      // 最初の 1 通だけ全行
      const frame = this.vtFrames.build(entry.session.snapshot(), true);
      this.send({
        type: "vt-opened",
        sessionId: entry.id,
        frame: frame ?? emptyVtFrame(entry.session.snapshot().rows, entry.session.snapshot().cols),
        encoding: entry.encoding,
        ibmI: entry.session.isIbmI,
        hostEchoes: entry.session.hostEchoes
      });
    });
  }

  /**
   * **VT への入力。**
   *
   * 打鍵は意味のまま届き、バイト列への符号化は `VtSession` が現在のモードで行う（spec D4）。
   * 監査は**キーの名前だけ**を残す——`text` には打った文字そのものが入るので、
   * パスワードを入力している最中の内容を記録に残してはならない。
   */
  private onVtInput(msg: WsClientMessage & { type: "vt-input" }): void {
    const mgr = this.deps.vt;
    const id = this.sessionVt;
    if (mgr === undefined || id === undefined) {
      throw new As400Error("SESSION_NOT_FOUND", "no VT session opened on this connection");
    }
    const entry = mgr.get(id, this.user?.username);
    if (entry.readOnly) throw new As400Error("READ_ONLY_SESSION", "session is read-only");
    if (msg.paste !== undefined) {
      entry.session.paste(msg.paste);
      return;
    }
    if (msg.mouse !== undefined) {
      entry.session.mouse(msg.mouse);
      return;
    }
    if (msg.key !== undefined) {
      entry.session.key({
        key: msg.key as VtKeyName,
        ...(msg.ctrl !== undefined ? { ctrl: msg.ctrl } : {}),
        ...(msg.alt !== undefined ? { alt: msg.alt } : {}),
        ...(msg.shift !== undefined ? { shift: msg.shift } : {})
      });
      return;
    }
    if (msg.text !== undefined && msg.text !== "") {
      // **`Ctrl` つきの文字は `key` ではなく `text` で来る**（`Ctrl+C` など）
      if (msg.ctrl === true || msg.alt === true) {
        entry.session.key({
          text: msg.text,
          ...(msg.ctrl !== undefined ? { ctrl: msg.ctrl } : {}),
          ...(msg.alt !== undefined ? { alt: msg.alt } : {})
        });
        return;
      }
      entry.session.text(msg.text);
    }
  }

  /** ペインの大きさが変わった。**NAWS でホストへ伝わり `stty size` が追随する** */
  private onVtResize(msg: WsClientMessage & { type: "vt-resize" }): void {
    const mgr = this.deps.vt;
    const id = this.sessionVt;
    if (mgr === undefined || id === undefined) {
      throw new As400Error("SESSION_NOT_FOUND", "no VT session opened on this connection");
    }
    const entry = mgr.get(id, this.user?.username);
    entry.session.resize(msg.rows, msg.cols);
    // **大きさが変わったら全行を送り直す**（差分の土台が変わっているため）
    this.vtFrames?.reset();
  }

  /**
   * 3270 のキー送信。
   *
   * 5250 と違い**ホスト応答を待たない**——3270 は AID を送るとキーボードが施錠され、
   * ホストが `WCC` の復旧ビットで解く。応答画面は `screen` イベントで届くので、
   * `key-done` には**送った直後の画面**（施錠状態が見える）を載せる。
   */
  private async onKey3270(msg: WsClientMessage & { type: "key" }): Promise<void> {
    const mgr = this.deps.tn3270;
    const id = this.session3270;
    if (mgr === undefined || id === undefined) {
      throw new As400Error("SESSION_NOT_FOUND", "no 3270 session opened on this connection");
    }
    await withAudit({ op: "ws_key", sessionId: id, key: msg.key }, async () => {
      const entry = mgr.get(id, this.user?.username);
      if (entry.readOnly) throw new As400Error("READ_ONLY_SESSION", "session is read-only");
      // **ホストの種類で送り方が変わる**（IBM i の F キーは `PA1` ＋ `PFn`）。
      // 表はここ 1 か所にしか置かない——画面側にも置くと必ずずれる
      const plan = planKey3270(msg.key, entry.session.isIbmI);
      if (msg.cursor) entry.session.setCursor(msg.cursor.row, msg.cursor.col);
      if (msg.fields && msg.fields.length > 0) applyFields(entry.session, msg.fields);
      if (plan.kind === "functionKey") await entry.session.sendFunctionKey(plan.n);
      else entry.session.send(plan.aid);
      this.send({
        type: "key-done",
        sessionId: id,
        screen: toWireScreen(entry.session, id),
        timedOut: false
      });
    });
  }

  private async onOpenPrinter(msg: WsClientMessage & { type: "open" }): Promise<void> {
    await withAudit({ op: "ws_open_printer" }, async () => {
      const opts: Parameters<SessionManager["openPrinter"]>[0] = { origin: originOf(msg) };
      if (hasRef(msg)) {
        // 保存済み設定由来。printer 出力を供給するかは ConfigResolver が判定済み
        // （サーバー設定のセッションのときだけ返る＝信頼境界の 5 層目）
        const t = this.resolveTarget(msg);
        const co = t.connect;
        if (co.host !== undefined) opts.host = co.host;
        if (co.port !== undefined) opts.port = co.port;
        if (co.ccsid !== undefined) opts.ccsid = co.ccsid;
        if (co.deviceName !== undefined) opts.deviceName = co.deviceName;
        if (co.tls !== undefined) opts.tls = co.tls;
        if (co.user !== undefined) opts.user = co.user;
        if (co.password !== undefined) opts.password = co.password;
        if (co.rescueAction !== undefined) opts.rescueAction = co.rescueAction;
        if (co.transformTo !== undefined) opts.transformTo = co.transformTo;
        // **転記漏れに注意**: ここはキーごとの手写しなので、足し忘れると
        // 「表示セッションだけ設定が効く」状態になる（display 側は `{...target.connect}`）
        if (co.idleTimeoutMs !== undefined) opts.idleTimeoutMs = co.idleTimeoutMs;
        if (t.printerOutput) opts.output = t.printerOutput;
        // **常駐はここで決まる。** 出力設定の有無からは導出しない（design D3）
        if (t.service) opts.service = true;
        // **開き直したときに既存へ繋ぐ鍵。** 直接接続には無い
        if (msg.session !== undefined) opts.ref = msg.session;
        // 開いた直後に待ち受けるか（定義由来。既定は開始する）
        if (!t.autoStart) opts.autoStart = false;
      } else {
        // 直接接続（ブラウザ指定）: 出力設定は受け付けない（任意パス書込・任意コマンド実行の防止）
        if (msg.host !== undefined) opts.host = msg.host;
        if (msg.port !== undefined) opts.port = msg.port;
        if (msg.ccsid !== undefined) opts.ccsid = msg.ccsid;
        if (msg.deviceName !== undefined) opts.deviceName = msg.deviceName;
        if (msg.tls === true) opts.tls = true;
        if (msg.user !== undefined) opts.user = msg.user;
        if (msg.password !== undefined) opts.password = msg.password;
      }
      if (this.user) opts.owner = this.user.username;
      const entry = await this.deps.sessions.openPrinter(opts);
      this.sessionId = entry.id;
      this.startHeartbeat();
      const onReport = (r: StoredReport): void =>
        this.send({ type: "report", sessionId: entry.id, report: spoolReportMsg(r) });
      // **救出した帳票もここへ流す。** ホスト由来の report イベントだけを見ていると、
      // 書き出しできないスプールを拾った分が画面に出ない（entry 経由で配られるため）。
      entry.onReport = onReport;
      // **状態の変化を push する**（監視と同じ扱い。「黙って止まらない」ため）
      entry.onState = (s) =>
        this.send({
          type: "printer-state",
          sessionId: entry.id,
          state: s.state,
          ...(s.error !== undefined ? { error: s.error } : {}),
          ...(s.startupCode !== undefined ? { startupCode: s.startupCode } : {})
        });
      this.detachReport = () => {
        delete entry.onOutputWarn; // 切断でフックを解除（リーク防止）
        delete entry.onReport;
        delete entry.onOutputStatus;
        delete entry.onState;
      };
      // 自動出力の失敗を UI へ push（サーバーログ・履歴は session-manager 側で保持）
      entry.onOutputWarn = (w) =>
        this.send({ type: "printer-warn", sessionId: entry.id, at: w.at, message: w.message });
      // 自動出力の結果（成功も含む）を UI へ push
      entry.onOutputStatus = (s) => this.send({ type: "printer-output-result", sessionId: entry.id, status: s });
      this.send({
        type: "printer-opened",
        sessionId: entry.id,
        // **「開く」と「待ち受ける」は別。** `autoStart ☐` なら `stopped` で返り、
        // 起動応答コードはまだ無い（`20260801-service-start-stop`）
        state: entry.state,
        ...(entry.session ? { startupCode: entry.session.startupCode } : {}),
        hasOutput: entry.output !== undefined,
        outputEnabled: entry.outputEnabled,
        outputWarnings: entry.outputWarnings,
        // **閉じている間に届いたぶんを渡す。** これが無いと
        // 「繋がったが閉じている間のものは見えない」になる
        reports: entry.reports.map(spoolReportMsg),
        receivedTotal: entry.receivedTotal,
        outputStatuses: entry.outputStatuses
      });
    });
  }

  /** 自動出力（PDF 保存・自動印刷）の有効/無効を切り替える */
  private async onPrinterOutput(msg: WsClientMessage & { type: "printer-output" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_printer_output", sessionId: id }, async () => {
      const entry = this.deps.sessions.setPrinterOutputEnabled(id, msg.enabled, this.user);
      this.send({ type: "printer-output-state", sessionId: id, enabled: entry.outputEnabled });
    });
  }

  /** system / session 参照を解決する（認可・復号・printer 出力の判定は ConfigResolver 内） */
  /**
   * 開いた設定の**安定した名前**を記録する（`SessionEntry.target`）。
   *
   * 実行中のセッション id は起動のたびに変わるので、外部の自動化（HLLAPI）が
   * 「**どのシステムのどのセッション**を操作したいか」を書けない。設定の参照と名前を
   * 添えておけば、開き直しても同じ指定で当たる。
   */
  /**
   * 画面・PC コマンド・予約を購読し、**見ている人として数える**。
   *
   * 新規に開いたときも既存へ繋いだときも同じことをするので 1 箇所にまとめる
   * ——**片方に足し忘れると、attach したタブだけ通知が来ない**という壊れ方をする。
   */
  private subscribeSession(entry: SessionEntry): void {
    // ホスト発の画面更新を push
    const onScreen = (screen: ScreenSnapshot): void => this.send({ type: "screen", screen });
    entry.session.on("screen", onScreen);
    entry.session.on("closed", (reason: string) => {
      this.send({ type: "closed", reason });
      this.detachScreen?.();
    });
    // PC コマンド（STRPCCMD）の実行状況を push。切断で購読を外す（リーク防止）。
    // **自分の分だけ外れる**——同じセッションを別のタブも見ていることがある
    const offPc = this.deps.sessions.subscribePcCommand(entry.id, (event) =>
      this.send({ type: "pc-command", sessionId: entry.id, event })
    );
    // 予約（HLLAPI の Reserve）の開始・解除を push。**画面と別に流す**——
    // 予約は画面を変えずに始まり・終わるので、screen に相乗りさせると取りこぼす
    const offRes = this.deps.sessions.subscribeReservation(entry.id, (r) =>
      this.send({ type: "reserved", ...(r ? { by: r.label } : {}) })
    );
    // **見ている人として数える。** 自動操作（MCP）が予約を取るかの判断に使う
    // ——誰も見ていないセッションを締め切っても、守る相手が居ない
    this.deps.sessions.addViewer(entry.id);
    this.detachScreen = () => {
      entry.session.off("screen", onScreen);
      offPc();
      offRes();
      this.deps.sessions.removeViewer(entry.id);
    };
  }

  /**
   * **既存のセッションへ繋ぐ**（新規に開かない）。
   *
   * MCP や HLLAPI が開いた画面を、あとからブラウザで見るための経路。
   * **状態を変えない**——繋ぎ直しただけで勝手に何かを再開しない
   * （プリンターの `20260801-printer-attach-by-ref` と同じ判断）。
   *
   * 「存在し、自分のものか」の判定は **`sessions.get(id, user)` に任せる**。
   * 画面側だけで見ると、リロード直後はまだ一覧が届いておらずすり抜ける。
   */
  private attach(sessionId: string): void {
    const entry = this.deps.sessions.get(sessionId, this.user); // 無ければ／他人のものなら例外
    this.sessionId = entry.id;
    this.attached = true;
    this.startHeartbeat();
    this.subscribeSession(entry);
    this.send({
      type: "opened",
      sessionId: entry.id,
      screen: entry.session.snapshot(),
      // **CCSID は `SessionEntry` が持っていない**（開いたときの設定に属する）。
      // attach では既定を返す——画面の文字変換は既にセッション側で決まっており、
      // ここで返す値は web-ui の入力補助（カナ大文字化）にしか使われない
      ccsid: 37,
      pcCommand: entry.pcCommandEnabled,
      ...(() => {
        const r = this.deps.sessions.reservationOf(entry.id);
        return r ? { reservedBy: r.label } : {};
      })(),
      ...(entry.job !== undefined ? { job: entry.job } : {})
    });
  }

  private targetOf(msg: WsClientMessage & { type: "open" }): SessionTarget {
    const name = msg.session
      ? this.deps.resolver.listSessions(this.user).find((s) => s.ref === msg.session)?.name
      : undefined;
    return {
      ...(msg.system !== undefined ? { system: msg.system } : {}),
      ...(msg.session !== undefined ? { session: msg.session } : {}),
      ...(name !== undefined ? { name } : {})
    };
  }

  private resolveTarget(msg: WsClientMessage & { type: "open" }): ResolvedTarget {
    return this.deps.resolver.resolve(
      { system: msg.system, session: msg.session },
      this.user,
      (m) => wsLog.warn(m)
    );
  }

  private async onKey(msg: WsClientMessage & { type: "key" }): Promise<void> {
    if (this.session3270 !== undefined) return this.onKey3270(msg);
    if (this.sessionVt !== undefined) {
      // **VT にはキーの一括送信が無い。** フィールドも AID キーも無いので、
      // `key` を受けても何を送ればよいか決まらない。`vt-input` を使わせる
      throw new As400Error("PROTOCOL_ERROR", "VT のセッションでは vt-input を使ってください");
    }
    const id = this.requireSession();
    await withAudit({ op: "ws_key", sessionId: id, key: msg.key }, async () => {
      const entry = this.deps.sessions.assertKeyAllowed(id, msg.key as AidKey, this.user);
      if (msg.fields && msg.fields.length > 0) {
        this.deps.sessions.assertWritable(id, this.user);
        // **秘密の解決はフィールドを 1 つでも書く前に済ませる**（spec D11）。
        // 途中で失敗して throw すると、それまでに書いた欄だけがホストに残り、
        // 「ユーザー名は入ったがパスワードは空」という中途半端な状態で AID を待つことになる。
        const values = msg.fields.map((f) => this.resolveField(f));
        for (const { field, value } of values) {
          entry.session.setField(typeof field === "number" ? { index: field } : field, value);
        }
      }
      // 応答画面は session の screen イベントで push される。
      // ただし表示を変えないキーではイベントが起きず、**タイムアウト復帰でも起きない**。
      // 後者では keyboardLocked が解除された画面が screen イベントに乗らないため、
      // sendAid の戻り値（解除後の画面）を key-done に必ず載せる。
      const res = await entry.session.sendAid(msg.key as AidKey, {
        ...(msg.cursor ? { cursor: msg.cursor } : {}),
        // システム要求行の文字列。SysReq 以外に付いていれば core が PROTOCOL_ERROR で弾く
        ...(msg.sysReqText !== undefined ? { sysReqText: msg.sysReqText } : {})
      });
      this.send({ type: "key-done", sessionId: id, screen: res.screen, timedOut: res.timedOut });
    });
  }

  /**
   * 書き込む 1 欄を「値」に確定する。マクロの秘密参照ならここで復号する（spec D11）。
   *
   * **平文はこの関数の戻り値としてしか存在しない**——ログにも監査にも残さず、
   * `setField` へ渡してそのまま捨てる。`ws_key` 監査には既に `key` が載っており、
   * どのマクロを再生したかは参照（macroId/step/field）だけで追える。
   *
   * 解決できないときは throw して**キー送信自体を落とす**。空文字で代替すると、
   * ホストには「パスワード欄が空」で届き、サインオン失敗の原因が分からなくなる。
   */
  private resolveField(f: WsKeyField): { field: WsFieldRef; value: string } {
    if ("value" in f) return { field: f.field, value: f.value };
    const store = this.deps.macros;
    if (!store) {
      throw new As400Error("CONFIG_ERROR", "macro store is not configured; cannot replay macro secrets");
    }
    // ws メッセージは JSON.parse したままの生データ。**秘密を守る経路なので形を検証する**——
    // 検証せずに渡すと、壊れた参照が素の TypeError になって JS のエラー文がそのまま client へ返る
    const ref = macroSecretRefSchema.safeParse(f.secretRef);
    if (!ref.success) {
      throw new As400Error("PROTOCOL_ERROR", `invalid secretRef: ${ref.error.message}`);
    }
    return { field: f.field, value: store.resolveSecret(ref.data, this.user) };
  }

  private async onGuiSelect(msg: WsClientMessage & { type: "gui-select" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_gui_select", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id, this.user);
      const ok = entry.session.selectGuiChoice(msg.fieldId, msg.choiceIndex, msg.selected ?? true);
      if (!ok) throw new As400Error("FIELD_TYPE", `選択できません（fieldId=${msg.fieldId}）`);
      // 更新画面は session の screen イベントで push される
    });
  }

  private async onGuiSubmit(msg: WsClientMessage & { type: "gui-submit" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_gui_submit", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id, this.user);
      const opts: { key?: AidKey; cursor?: { row: number; col: number } } = {};
      if (msg.key) opts.key = msg.key as AidKey;
      if (msg.cursor) opts.cursor = msg.cursor;
      await entry.session.submitGuiSelection(msg.fieldId, opts);
    });
  }

  private requireSession(): string {
    if (!this.sessionId) {
      // **3270 のときは理由を言い分ける。** 「セッションが無い」と返すと、
      // 開いているのに使えないのか、そもそも開いていないのかが利用者に分からない
      if (this.session3270 !== undefined) {
        throw new As400Error("PROTOCOL_ERROR", "this operation is not available on a 3270 session");
      }
      if (this.sessionVt !== undefined) {
        throw new As400Error("PROTOCOL_ERROR", "this operation is not available on a VT session");
      }
      throw new As400Error("SESSION_NOT_FOUND", "no session opened on this connection");
    }
    return this.sessionId;
  }

  private dispose(reason: string): void {
    this.stopHeartbeat();
    // **監視は止めない。** 購読を外すだけ——監視はレジストリが所有しており、
    // ブラウザを閉じても続くことが要件（research F1）
    this.detachWatch?.();
    this.detachWatch = undefined;
    this.detachScreen?.();
    this.detachScreen = undefined;
    this.detachReport?.();
    this.detachReport = undefined;
    this.detachVt?.();
    this.detachVt = undefined;
    this.vtFrames = undefined;
    if (this.sessionVt !== undefined) {
      // **VT も見ている人が閉じたら切る**（3270 と同じ。共有する経路がまだ無い）
      this.deps.vt?.close(this.sessionVt);
      this.sessionVt = undefined;
    }
    this.detach3270?.();
    this.detach3270 = undefined;
    if (this.session3270 !== undefined) {
      // **3270 は見ている人が閉じたら切る。** 5250 のように MCP や HLLAPI が
      // 同じセッションを共有する経路がまだ無いので、残す理由が無い
      this.deps.tn3270?.close(this.session3270);
      this.session3270 = undefined;
    }
    if (this.sessionId) {
      // **常駐プリンターは切らない。** 監視と同じで、購読を外すだけ——
      // 「設定が仕事をする」サービス型なので、タブを閉じたら帳票が来なくなるのは
      // 利用者の期待に反する（design D1）。フック（onReport / onOutputWarn /
      // onOutputStatus）は上で外しているが、**記録はエントリ側に溜まり続ける**ので、
      // 開き直したときに閉じている間のぶんを読める
      // **繋いだだけのタブはセッションを閉じない。** 開いた人や MCP がまだ使っている
      // ——見に来た人が去っただけで相手の作業を殺してはいけない。
      //
      // 自分が開いたタブでも、**他に見ている人が残っていれば閉じない**
      // （後から繋いだタブが残っているのに画面が消える、を避ける）
      const otherViewers = this.deps.sessions.hasViewer(this.sessionId);
      if (!this.attached && !otherViewers && !this.deps.sessions.isResident(this.sessionId)) {
        void this.deps.sessions.close(this.sessionId).catch(() => {});
      }
      this.sessionId = undefined;
    }
    this.send({ type: "closed", reason });
  }

  private send(msg: WsServerMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  private sendError(code: string, message: string, fatal: boolean): void {
    this.send({ type: "error", code, message, fatal });
  }
}

function buildDirect(msg: {
  host?: string;
  port?: number;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  enhanced?: boolean;
  tls?: boolean;
  user?: string;
  password?: string;
}): OpenOptions {
  if (!msg.host) throw new As400Error("CONFIG_ERROR", "host or profile required");
  const o: OpenOptions = { host: msg.host, origin: "direct" };
  if (msg.port !== undefined) o.port = msg.port;
  if (msg.ccsid !== undefined) o.ccsid = msg.ccsid;
  if (msg.screenSize !== undefined) o.screenSize = msg.screenSize;
  if (msg.deviceName !== undefined) o.deviceName = msg.deviceName;
  if (msg.enhanced !== undefined) o.enhanced = msg.enhanced;
  if (msg.tls === true) o.tls = true;
  if (msg.user !== undefined) o.user = msg.user;
  if (msg.password !== undefined) o.password = msg.password;
  return o;
}
