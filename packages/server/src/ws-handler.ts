import { As400Error } from "@ts5250/base";
import { type AidKey, type ScreenSnapshot } from "@ts5250/tn5250";
import { childLog } from "./log.js";
import {
  SessionManager,
  type OpenOptions,
  type SessionEntry,
  type SessionTarget,
  type StoredReport,
  type PrinterListener,
  type PcCommandEvent
} from "./session-manager.js";
import type { ConnRole } from "./session-lifetime.js";
import type { WatchRegistry } from "./watch-registry.js";
import { sessionWatch } from "./config-types.js";
import { makeWatchSink } from "./webhook-sink.js";
import type { AuthUser } from "./auth.js";
import type { ConfigResolver, ResolvedTarget } from "./config-resolver.js";
import { audit, withAudit } from "./audit.js";
import type { SpoolReportMsg, WsClientMessage, WsFieldRef, WsKeyField, WsServerMessage } from "./ws-messages.js";
import type { MacroStore } from "./macro-store.js";
import type { Tn3270Manager } from "./tn3270-manager.js";
import { applyFields, planKey3270, toWireScreen } from "./tn3270-adapt.js";
import type { VtManager } from "./vt-manager.js";
import { VtFrameBuilder, type WsVtFrame } from "./vt-wire.js";
import type { VtKeyName, VtEncoding } from "@ts5250/vt";
import { macroSecretRefSchema } from "./macro-types.js";
import { parseFieldId, parseFieldValue, parseKeyFieldShape, parseKeyFields } from "./ws-field-ref.js";

const wsLog = childLog({ component: "ws-handler" });

/**
 * **例外を「値を漏らさない形」でログに載せる。**
 *
 * 返すのは `code`（`As400Error` のもの）と**スタックのフレームだけ**。
 * message を外すのは、検証エラーの文言が**打鍵した値をそのまま埋めていた**ため
 * （`packages/tn5250/src/screen/field-validate.ts` の `JSON.stringify(value)`。
 * **その埋め込みは `20260920-field-error-no-value` で撤去した**——いまの文言は
 * `field at (20,7) accepts digits only` のように位置と理由だけ）。
 * その値はマクロ由来の秘密でもありうる（`resolveSecret`）。
 * **撤去後もここで message を外し続ける**のは、core 側で値を出さないことと
 * ログに値を出さないことは**別々に保たれるべき**だから（片方が緩んでも漏れない）。
 *
 * **まず message のぶんを長さで切り落とし、そのうえで `at ` の行だけを残す。**
 *
 * この形に辿り着くまでに 3 回間違えた（どちらも**測らずに書いた**のが原因。
 * `AGENTS.md` 判断の原則 2。`20260920-restore-screen-parity` review ラウンド 2・3・4）:
 * - ~~`String(e)`~~ → message ごと出る
 * - ~~`stack` の 1 行目を落とす~~ → **message は複数行になりうる**
 *   （当時 `resolveField` が投げていた `invalid secretRef: ${ZodError.message}` は整形 JSON で、実測で 12 行中 3 行。
 *   **その文言は `20260920-field-error-no-value` で撤去した**が、複数行 message は他にも来うるので防御は残す）
 * - ~~`at ` の行だけを残す~~ → **message の行頭が `at ` なら残る**
 *   （合成した例外で再現した。**いまの経路でそうなる値は確かめていない**——
 *   当時の `field-validate.ts` は `JSON.stringify(value)` で打鍵値の改行をエスケープしており行頭を作れず、
 *   zod の整形 JSON の行頭は `"`/`{`/`[` になる。**いまはどちらの文言も値を含まない**。
 *   塞ぐ理由は「実際に漏れた」ではなく
 *   **行の形で選ぶ方式そのものが保証を持たない**こと）
 *
 * **`message` が占める行数ぶんを先頭から落とし、そのうえで `at ` の行だけを残す。**
 *
 * ~~`stack` が `<name>: <message>` で始まると見なして長さで切る~~ は**この Node でも外れる**
 * （実測。同 review ラウンド 5）:
 * - Node 内部の `ERR_*` は頭が `TypeError [ERR_INVALID_ARG_TYPE]: …` なのに `name` は `"TypeError"`
 * - `message` が空だと V8 は `": "` を出さない（`"As400Error\n    at …"`）
 *
 * どちらも `startsWith` が外れ、**閉じる側に倒すと `at` が丸ごと消える**
 * ——`setField` / `resolveField` の失敗をいちばん切り分けたい場面で位置が残らない。
 * 行数で落とせば、上の 2 形と通常・複数行の 4 形すべてでフレームが採れる（実測で確認）。
 * **message の行数は message からしか作れないので、どんな頭でも値は残らない。**
 *
 * フレームは**先頭 3 つまで**。どこで投げたかが分かれば足りるうえ、全部載せると
 * node_modules まで含む十数行が warn 1 本に付く。
 *
 * `AGENTS.md`「セキュリティ / 秘密の扱い」の「ログにも値を出さない」。
 */
export function errShape(e: unknown): { code?: string; at?: string } {
  const code = e instanceof As400Error ? e.code : undefined;
  const frames =
    e instanceof Error && typeof e.stack === "string" ? stackFrames(e) : undefined;
  return { ...(code !== undefined ? { code } : {}), ...(frames ? { at: frames } : {}) };
}

/** `errShape` の本体。message のぶんを長さで切ってから `at ` の行を 3 つまで拾う */
function stackFrames(e: Error): string {
  // **落とすのは message の行数ぶん**（1 行目は `<name>: <message の 1 行目>`）。
  // `at ` での絞り込みは**そのうえで**掛ける——行の形だけで選ぶと、行頭が `at ` の message が紛れる
  const messageLines = String(e.message).split("\n").length;
  return e.stack!
    .split("\n")
    .slice(messageLines)
    .filter((l) => /^\s*at /.test(l))
    .slice(0, 3)
    .map((l) => l.trim())
    .join(" / ");
}

/**
 * 施錠されたままの画面（＝ホスト応答の途中）を押し出すまでの待ち。
 *
 * 実機 YB0140R の窓で PageUp すると、1 回の AID に対して 4 レコードが **40ms の間に
 * 12〜15ms 間隔**で届く（`scripts/verify-browser-yb0140r-window.mjs` で実測）。
 * この待ちがそれを十分またぐので、途中経過は最新 1 枚にまとまる。
 * 一方、鍵盤が開いた画面は待たずに出すので、**操作の体感は遅くならない**。
 */
const SCREEN_COALESCE_MS = 50;

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

/**
 * **解決結果（保存済みのプリンターの設定）から、プリンターを開く材料を作る**（`onOpenPrinter` と関連付けるプリンター
 * `SessionManager.linkAssociatedPrinter` の前の起動が同じ道を通る——2 か所に手写しすると信頼設定〔PDF 出力先・自動印刷・常駐〕の扱いが
 * 片方だけ食い違う。`20260921-associated-printer-session`）。
 *
 * ⚠ **転記漏れに注意**: キーごとの手写しなので、足し忘れると「表示セッションだけ設定が効く」状態になる（表示側は `{...target.connect}`）
 */
export function printerOptsFrom(t: ResolvedTarget): Parameters<SessionManager["openPrinter"]>[0] {
  const opts: Parameters<SessionManager["openPrinter"]>[0] = {};
  const co = t.connect;
  if (co.host !== undefined) opts.host = co.host;
  if (co.port !== undefined) opts.port = co.port;
  if (co.ccsid !== undefined) opts.ccsid = co.ccsid;
  if (co.deviceName !== undefined) opts.deviceName = co.deviceName;
  // 常駐の経路（`{...t.connect}`）では渡っていたのに、ここだけ落ちていた（節目の点検の指摘）
  if (co.deviceNameRetry !== undefined) opts.deviceNameRetry = co.deviceNameRetry;
  if (co.tls !== undefined) opts.tls = co.tls;
  if (co.user !== undefined) opts.user = co.user;
  if (co.password !== undefined) opts.password = co.password;
  if (co.rescueAction !== undefined) opts.rescueAction = co.rescueAction;
  if (co.transformTo !== undefined) opts.transformTo = co.transformTo;
  if (co.idleTimeoutMs !== undefined) opts.idleTimeoutMs = co.idleTimeoutMs;
  if (t.printerOutput) opts.output = t.printerOutput;
  // **常駐はここで決まる。** 出力設定の有無からは導出しない（design D3）
  if (t.service) opts.service = true;
  // 開いた直後に待ち受けるか（定義由来。既定は開始する）
  if (!t.autoStart) opts.autoStart = false;
  return opts;
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
  /**
   * **この接続が結びついている 5250 表示セッション / プリンター**（id と役割）。
   *
   * id・「見に来ただけか」・持ち主の印を独立フィールドに持っていた頃は、3 つの整合を
   * 呼び出し側が保つ必要があり、後始末の判断が `ws-handler` と `SessionManager` に
   * またがって散った（`20260908-session-lifetime-rules-fold`）。**1 欄に畳むと、
   * 「id はあるが役割が無い」という状態が型で作れなくなる。**
   *
   * 役割の意味と、それが後始末の処分をどう決めるかは `session-lifetime.ts`。
   */
  private link: { readonly id: string; readonly role: ConnRole } | undefined;
  /**
   * 5250 表示セッション / プリンターの id。**`link` からの導出**（読み取り専用）。
   * 書き換えは `link` を通す——片方だけ更新される形を作らないため。
   */
  private get sessionId(): string | undefined {
    return this.link?.id;
  }
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
  private detachReport: (() => void) | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** 後始末（`dispose`）に入ったか。開く途中で切れた接続が、誰も持たないセッションを作らないための印 */
  private disposed = false;
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
        case "printer-output-retry":
          return await this.onPrinterOutputHeld("retry");
        case "printer-output-cancel":
          return await this.onPrinterOutputHeld("cancel");
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
      // **3270 のセッションは `session3270` に入る**（`sessionId` ではない）。
      // `sessionId` だけを見ていたため、**3270 では生きているセッション上の無害なエラーまで
      // `fatal: true`** になっていた——「この欄には 2 バイト文字を打てません」
      // （`FIELD_TYPE`）で接続ごと畳め、と言っていたことになる。
      // 状態で決める以上、**状態の在り処を全部見る**（`onOpen` の重複検査と同じ形）。
      //
      // ⚠ **セッションの置き場を増やしたらここも増やす。** 3270 を足したときに漏れて
      // 上の不具合になり、VT でも同じ形が繰り返せる状態だった。
      // `onOpen` / `dispose` / ここ の 3 か所が同じ列を見る。
      const fatal =
        code === "SESSION_CLOSED" ||
        (this.sessionId ?? this.session3270 ?? this.sessionVt) === undefined;
      this.sendError(code, err instanceof Error ? err.message : String(err), fatal);
    }
  }

  /** WebSocket 切断時に呼ぶ（セッションを破棄） */
  onSocketClose(): void {
    // **意図しない切断**。利用者が閉じた（`close` メッセージ）のとは別物として扱う
    // ——こちらだけが繋ぎ直しの猶予に値する（`20260908-session-survives-disconnect` decisions D5）
    this.dispose("websocket closed", { transportLost: true });
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
        this.dispose("heartbeat timeout", { transportLost: true });
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
    // この open のための印。前の `close` メッセージの後始末（`dispose`）が立てた印を引きずらない
    this.disposed = false;
    await withAudit({ op: "ws_open" }, async () => {
      // **既存セッションへ繋ぐ**なら、ここで終わる——新しい接続は作らない
      if (msg.sessionId !== undefined) return this.attach(msg.sessionId, { resume: msg.resume === true });
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
      // **ブラウザの端末はホストに切られたら自動で繋ぎ直す**（ACS と同じ。`20260921-auto-reconnect`）。
      // ACS も ECL のコアは既定 OFF で、画面の層（HOD の bean）が ON にする。MCP の自動操作は OFF のまま
      opts.autoReconnect = true;
      // **関連付けるプリンターセッション**（設定で指したときだけ。ACS の画面の層の機能なので MCP・HLLAPI から開く表示には効かせない。
      // `20260921-associated-printer-session`）。プリンターを起こして装置名を待ち、その装置名で関連付けて表示を開く
      const assoc = hasRef(msg) ? await this.prepareAssociation(msg, opts) : undefined;
      // 準備（プリンターの起動・装置名待ち）の間に接続が切れていたら、表示は作らない（数秒〜数分の窓。誰も持たない表示が残る）。
      // 起こしたプリンターは、表示を閉じたときと同じ処置で片付ける（`20260921-associated-printer-session` の節目 10 の独立点検 C-S4）
      if (this.disposed) {
        if (assoc?.printerId !== undefined) this.deps.sessions.abortAssociatedPrinter(assoc.printerId, assoc.closeWithLast);
        return;
      }
      let entry: Awaited<ReturnType<SessionManager["open"]>>;
      try {
        entry = await this.deps.sessions.open(opts);
      } catch (e) {
        // 表示を開けなかった（ホストに届かない・サインオンの拒否・装置使用中・上限）。起こしたプリンターを止める（ACS は表示が切れればプリンターを止める。C-S3）
        if (assoc?.printerId !== undefined) this.deps.sessions.abortAssociatedPrinter(assoc.printerId, assoc.closeWithLast);
        throw e;
      }
      // **開く待ちの間に切れていたら、誰も持たないので閉じる**（`opened` を送っても受け取る側が居ない。以前からある窓）
      if (this.disposed) {
        await this.deps.sessions.close(entry.id).catch(() => undefined);
        return;
      }
      if (assoc?.printerId !== undefined) this.deps.sessions.linkAssociatedPrinter(entry.id, assoc.printerId, assoc.closeWithLast);
      // 自分で開いた＝持ち主（去るときに畳む責任を持つ）
      this.link = { id: entry.id, role: { kind: "owner", token: this.deps.sessions.claim(entry.id) } };
      this.startHeartbeat();
      this.subscribeSession(entry);
      this.send({
        type: "opened",
        sessionId: entry.id,
        screen: entry.session.snapshot(),
        ccsid: opts.ccsid ?? 37,
        pcCommand: entry.pcCommandEnabled,
        ...this.pcCommandBacklog(entry.id),
        ...hostReconnectOf(entry.session),
        // **後から入ったタブにも今の予約状態を伝える**（開始の push を聞き逃していても揃う）
        ...(() => {
          const r = this.deps.sessions.reservationOf(entry.id);
          return r ? { reservedBy: r.label } : {};
        })(),
        // 起動応答で分かる範囲（装置名＝ジョブ名）は接続と同時に出せる
        ...(entry.job !== undefined ? { job: entry.job } : {}),
        ...startupCodeOf(entry.session),
        // 関連付けるプリンターが使えず関連付けなしで開いたとき、その理由（利用者へ知らせる。ACS はポップアップで知らせる）
        ...(assoc?.issue !== undefined ? { associatedPrinterIssue: assoc.issue } : {})
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
        pcCommand: false,
        ibmI: entry.session.isIbmI
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
      // VT もホスト側が終わった通知（`dispose` の後始末とは別物）
      const pushClose = (reason: string): void => this.send({ type: "closed", reason, ended: true });
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
      // **容れ物から検証する**（`ws-field-ref.ts` の `parseKeyFields`。5250 の `onKey` と同じ扱い）
      if (msg.fields !== undefined) {
        const fields3270 = parseKeyFields(msg.fields);
        if (fields3270.length > 0) applyFields(entry.session, fields3270 as WsKeyField[]);
      }
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

  /**
   * 表示を開く前の**関連付けるプリンターの準備**。装置名が分かれば `opts.associatedPrinter` に入れる（IBMASSOCPRT）。
   * 使えないときは**関連付けなしで開き**、その理由を返す（`opened.associatedPrinterIssue`。ACS はポップアップで知らせる）:
   * `invalid`＝指した設定が使えない（無い・プリンターでない・権限が無い）／`failed`＝プリンターを開始できなかった／`timeout`＝装置名が決まる前に待ち時間が切れた
   */
  private async prepareAssociation(
    msg: WsClientMessage & { type: "open" },
    opts: OpenOptions
  ): Promise<{ printerId?: string; closeWithLast: boolean; issue?: "invalid" | "failed" | "timeout" } | undefined> {
    const target = this.resolveTarget(msg);
    const want = target.associatedPrinterSession;
    if (!want) return undefined;
    // **サーバーが利用者に代わってプリンターを起こす副作用は、直接開く `ws_open_printer` と同じく監査に残す**（表示の `ws_open` に埋もれると、
    // 誰の操作でプリンターが起き、使えない・開けない・時間切れで関連付けなしになったかを追えない。`20260921-assoc-printer-audit`）。
    // `withAudit` は例外か MCP のエラー応答でしか `error` にしないので、理由（`issue`）を `code` に載せて直接出す。設定名・装置名は載せない（spec D14）。
    // 起こしたプリンターのセッション ID（実行時に振る UUID。秘密ではない）は載せる——それが無いと「どのプリンターが起きたか」を追えない
    // （独立点検 A-S8。`ws_open_printer` は `withAudit` が同じ欄に載せる）
    const t0 = Date.now();
    const result = await this.startAssociatedPrinter(want, opts);
    audit({
      op: "ws_associated_printer",
      ...(result.printerId !== undefined ? { sessionId: result.printerId } : {}),
      result: result.issue === undefined ? "ok" : "error",
      ...(result.issue !== undefined ? { code: result.issue } : {}),
      durationMs: Date.now() - t0
    });
    return result;
  }

  /** `prepareAssociation` の本体（指定があるときだけ呼ぶ）。結果の意味は上の JSDoc */
  private async startAssociatedPrinter(
    want: NonNullable<ResolvedTarget["associatedPrinterSession"]>,
    opts: OpenOptions
  ): Promise<{ printerId?: string; closeWithLast: boolean; issue?: "invalid" | "failed" | "timeout" }> {
    let printerTarget: ResolvedTarget;
    try {
      // プリンターの設定は**表示と同じ道**（`ConfigResolver`）で解決する——認可（サーバー設定は admin だけ等）も同じ
      printerTarget = this.deps.resolver.resolve({ session: want.ref }, this.user, (m) => wsLog.warn(m));
    } catch (e) {
      wsLog.warn({ session: want.ref, err: String(e) }, "associated printer session not usable; opening without association");
      return { closeWithLast: want.closeWithLast, issue: "invalid" };
    }
    if (printerTarget.session?.sessionType !== "printer") return { closeWithLast: want.closeWithLast, issue: "invalid" };
    const r = await this.deps.sessions.prepareAssociatedPrinter(
      want.ref,
      this.user?.username,
      () =>
        this.deps.sessions.openPrinter({
          ...printerOptsFrom(printerTarget),
          // **指したプリンターは必ず起こす**（ACS `SessionManager.startAssociatedPrinterSession`）。「自動で待ち受け開始 ☐」の定義でも、
          // 初回の表示で起こされず装置名が決まらないままにならない（2 本目の表示は既存の停止中を起こすので、初回だけ違う穴になっていた。C-S8）
          autoStart: true,
          origin: `associated:${want.ref}`,
          ref: want.ref,
          ...(this.user ? { owner: this.user.username } : {})
        }),
      want.timeoutMs
    );
    if ("error" in r) {
      wsLog.warn({ session: want.ref, err: r.error }, "associated printer session could not be opened; opening without association");
      return { closeWithLast: want.closeWithLast, issue: "failed" };
    }
    if (r.deviceName !== undefined) opts.associatedPrinter = r.deviceName;
    return { printerId: r.printerId, closeWithLast: want.closeWithLast, ...(r.issue !== undefined ? { issue: r.issue } : {}) };
  }

  private async onOpenPrinter(msg: WsClientMessage & { type: "open" }): Promise<void> {
    await withAudit({ op: "ws_open_printer" }, async () => {
      const opts: Parameters<SessionManager["openPrinter"]>[0] = { origin: originOf(msg) };
      if (hasRef(msg)) {
        // 保存済み設定由来。printer 出力を供給するかは ConfigResolver が判定済み
        // （サーバー設定のセッションのときだけ返る＝信頼境界の 5 層目）
        const t = this.resolveTarget(msg);
        // 解決結果からプリンターを開く材料を作る組み立ては 1 か所（`printerOptsFrom`。関連付けるプリンターも同じ道を通す）
        Object.assign(opts, printerOptsFrom(t));
        // **開き直したときに既存へ繋ぐ鍵。** 直接接続には無い
        if (msg.session !== undefined) opts.ref = msg.session;
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
      this.link = { id: entry.id, role: { kind: "owner", token: this.deps.sessions.claim(entry.id) } };
      this.startHeartbeat();
      // **タブごとに 1 つ付け、切断でそれだけを外す**（`PrinterListener`）。エントリに 1 つずつ持たせていたときは、
      // 同じ定義を 2 タブで開くと後のタブが上書きし、そのタブを閉じると先のタブにも何も届かなくなった（独立点検の指摘）
      const listener: PrinterListener = {
        // **救出した帳票もここへ流す。** ホスト由来の report イベントだけを見ていると、
        // 書き出しできないスプールを拾った分が画面に出ない（entry 経由で配られるため）。
        onReport: (r) => this.send({ type: "report", sessionId: entry.id, report: spoolReportMsg(r) }),
        // **状態の変化を push する**（監視と同じ扱い。「黙って止まらない」ため）
        onState: (st) =>
          this.send({
            type: "printer-state",
            sessionId: entry.id,
            state: st.state,
            ...(st.error !== undefined ? { error: st.error } : {}),
            ...(st.startupCode !== undefined ? { startupCode: st.startupCode } : {})
          }),
        // 自動出力の失敗を UI へ push（サーバーログ・履歴は session-manager 側で保持）
        onOutputWarn: (w) => this.send({ type: "printer-warn", sessionId: entry.id, at: w.at, message: w.message }),
        // 自動出力の結果（成功も含む）を UI へ push
        onOutputStatus: (st) => this.send({ type: "printer-output-result", sessionId: entry.id, status: st })
      };
      entry.listeners.add(listener);
      this.detachReport = () => {
        entry.listeners.delete(listener); // 切断で外す（リーク防止）。ほかのタブのものは触らない
      };
      this.send({
        type: "printer-opened",
        sessionId: entry.id,
        // **「開く」と「待ち受ける」は別。** `autoStart ☐` なら `stopped` で返り、
        // 起動応答コードはまだ無い（`20260801-service-start-stop`）
        state: entry.state,
        // **止まった理由も渡す。** push は繋いでいる間しか届かないので、
        // これが無いと「エラーとだけ出て理由が無い」になる
        ...(entry.error !== undefined ? { error: entry.error } : {}),
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

  /**
   * **止めている帳票の再試行・取消**（`20260921-printer-hold-response`）。権限は自動出力の切り替えと同じ
   * （`getPrinter` の所有者/admin）。結果は `printer-output-result` の push で画面へ届く
   */
  private async onPrinterOutputHeld(action: "retry" | "cancel"): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: action === "retry" ? "ws_printer_output_retry" : "ws_printer_output_cancel", sessionId: id }, async () => {
      if (action === "retry") this.deps.sessions.retryPrinterOutput(id, this.user);
      else this.deps.sessions.cancelPrinterOutput(id, this.user);
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
    // ホスト発の画面更新を push。
    //
    // **応答の途中経過は出さない（ACS と同じ見え方にする）。** 1 回の AID に対してホストは
    // 複数のレコードを返すことがあり、窓を持つ画面では
    // 「RESTORE SCREEN（窓が消えた背面）→ 小さな WTD → SAVE SCREEN → 窓を作り直し」
    // と続く（実機 YB0140R で実測。4 レコードが 40ms の間に 12〜15ms 間隔で届く）。
    // 1 レコードごとに push すると途中の「窓が消えた画面」が 1 フレーム描かれ、
    // 利用者にはちらつきとして見える。
    //
    // ACS は受信経路で画面更新イベントを出さない——`DS5250` は受け取ったレコードを
    // 共有の PS（`PS5250`）へ次々に当てるだけで、描画側はその時点の PS を読んで描く。
    // 途中の状態は次のレコードに上書きされ、描かれないまま消える
    // （`ECLPS.endOfRecord()` の画面イベント発火は AID **送信**側の経路。加えて
    // `DS5250$AvoidThrashingWTD` という描画間引きの仕組みまで持っている）。
    // ここで同じことをする: **鍵盤が開いた画面（＝ホストが入力待ちになった＝操作員に
    // 渡った画面）は即座に、途中の施錠されたままの画面は一拍おいて最新だけを** 出す。
    let pendingScreen: ScreenSnapshot | undefined;
    let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
    const flushScreen = (): void => {
      if (coalesceTimer !== undefined) {
        clearTimeout(coalesceTimer);
        coalesceTimer = undefined;
      }
      if (pendingScreen === undefined) return;
      const screen = pendingScreen;
      pendingScreen = undefined;
      this.send({ type: "screen", screen });
    };
    const onScreen = (screen: ScreenSnapshot): void => {
      pendingScreen = screen;
      // 施錠されたままの画面は「まだ応答の途中」。**それでも必ず出す**——時間の掛かる
      // 処理の途中経過（「処理中です」等）を握り潰さないため、一拍だけ待って最新を出す
      if (screen.keyboardLocked) {
        if (coalesceTimer === undefined) coalesceTimer = setTimeout(flushScreen, SCREEN_COALESCE_MS);
        return;
      }
      flushScreen();
    };
    entry.session.on("screen", onScreen);
    // **警報は間引かずそのまま流す**（画面を変えないレコードでも来る。ACS も描画と独立に鳴らす）
    const onAlarm = (): void => this.send({ type: "alarm" });
    entry.session.on("alarm", onAlarm);
    // **ホストに切られて自動で繋ぎ直している**（`20260921-auto-reconnect`）。施錠した画面も送る
    // ——送らないと、ブラウザは切られる前の解錠された画面のまま打てると思い込む
    const onReconnecting = (e: { attempt: number; reason: string }): void => {
      this.send({ type: "host-reconnecting", attempt: e.attempt, reason: e.reason });
      this.send({ type: "screen", screen: entry.session.snapshot() });
    };
    const onReconnected = (startup?: { code: string }): void => {
      // 起動応答はイベントが運ぶ新しい接続のもの（ACS は繋ぎ直しでも開始の文言を出す。`20260921-startup-code-status`）
      this.send({ type: "host-reconnected", ...startupCodeOf({ startup: startup ?? entry.session.startup }) });
      // 装置名（＝ジョブ名）は繋ぎ直すと変わりうる。分かっている範囲をすぐ出し、残りは引けたら足す
      if (entry.job !== undefined) this.send({ type: "jobinfo", job: entry.job });
      void entry.jobResolved?.then((job) => {
        if (job?.user !== undefined && this.sessionId === entry.id) this.send({ type: "jobinfo", job });
      });
    };
    entry.session.on("reconnecting", onReconnecting);
    entry.session.on("reconnected", onReconnected);
    // **ホストが本当に終わった側**。こちらは繋ぎ直しても戻らないので `ended` を立てる
    // （`dispose` の末尾から送る `closed` とは意味が違う。`WsClosed.ended`）
    const onClosed = (reason: string): void => {
      this.send({ type: "closed", reason, ended: true });
      this.detachScreen?.();
    };
    entry.session.on("closed", onClosed);
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
      entry.session.off("alarm", onAlarm);
      entry.session.off("reconnecting", onReconnecting);
      entry.session.off("reconnected", onReconnected);
      // **`closed` も外す**。ホストに切られても終わらなくなった（繋ぎ直す）ぶん、外し忘れると
      // resume・attach のたびに購読が溜まる期間が延びる（独立点検の指摘。変更前からの外し忘れ）
      entry.session.off("closed", onClosed);
      if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
      offPc();
      offRes();
      this.deps.sessions.removeViewer(entry.id);
    };
  }

  /**
   * **既存のセッションへ繋ぐ**（新規に開かない）。
   *
   * MCP や HLLAPI が開いた画面を、あとからブラウザで見るための経路。
   * 既定（`resume` なし）は**状態を変えない**——繋ぎ直しただけで勝手に何かを再開しない
   * （プリンターの `20260801-printer-attach-by-ref` と同じ判断）。
   *
   * **`resume: true` だけは状態を変える**（`20260908-session-survives-disconnect` D4）:
   * 猶予を解き、持ち主の座を引き取る。「見に来た人」ではなく「回線が落ちて戻ってきた
   * 持ち主」なので、去るときにセッションを畳む責任も持つ。
   *
   * 「存在し、自分のものか」の判定は **`sessions.get(id, user)` に任せる**。
   * 画面側だけで見ると、リロード直後はまだ一覧が届いておらずすり抜ける。
   *
   * **この経路に来るのは 5250 表示セッションだけ**——`kind: "printer"` と
   * `terminal: "3270" | "vt"` は `onOpen` の手前で振り分けられ、`sessionId` ごと見られない。
   * `sessionId` の無い `resume: true` も同じく無視される（新規 open として扱う）。
   */
  private attach(sessionId: string, opts?: { resume?: boolean }): void {
    const entry = this.deps.sessions.get(sessionId, this.user); // 無ければ／他人のものなら例外
    if (opts?.resume === true) {
      // **持ち主として戻る**（`20260908-session-survives-disconnect` decisions D4）。
      // 役割は `owner`＝去るときにこの接続がセッションを畳む。猶予も解く
      // ——ここで解かないと、繋ぎ直した直後に元の期限で足元から閉じられる
      this.deps.sessions.cancelHold(entry.id);
      this.link = { id: entry.id, role: { kind: "owner", token: this.deps.sessions.claim(entry.id) } };
    } else {
      // **見に来ただけ。** 畳む責任を持たない（MCP が開いた画面を覗く使い方を壊さない）
      this.link = { id: entry.id, role: { kind: "viewer" } };
    }
    this.startHeartbeat();
    this.subscribeSession(entry);
    this.send({
      type: "opened",
      sessionId: entry.id,
      screen: entry.session.snapshot(),
      // **セッションが実際に使っている CCSID を返す**（`20260921-monocase-non-ascii` の節目の点検の指摘）。
      // ~~既定の 37 を返す——web-ui の入力補助（カナ大文字化）にしか使われない~~ → web-ui は CCSID で
      // 「SBCS だけのセッションか」を決め、打鍵の幅の判定と欄のバイト予算を切り替える。37 を返すと、930 の画面を
      // attach で見たタブが全角を 1 バイトと数えて欄の長さを越えて打てた
      ccsid: entry.session.ccsid,
      pcCommand: entry.pcCommandEnabled,
      ...this.pcCommandBacklog(entry.id),
      ...hostReconnectOf(entry.session),
      ...(() => {
        const r = this.deps.sessions.reservationOf(entry.id);
        return r ? { reservedBy: r.label } : {};
      })(),
      ...(entry.job !== undefined ? { job: entry.job } : {}),
      ...startupCodeOf(entry.session)
    });
  }

  /**
   * 留守中に実行された PC コマンドを `opened` に載せる（無ければ載せない）。
   *
   * `pc-command` の push は**購読者にしか届かない**ので、ブラウザを閉じている間の分は
   * 誰にも知らされないまま記録だけが残る。繋ぎ直しで渡す
   * （backlog `pc-command.md`「常駐セッションでの扱い」）。
   */
  private pcCommandBacklog(id: string): { pcCommands?: PcCommandEvent[] } {
    const history = this.deps.sessions.pcCommandHistory(id);
    return history.length > 0 ? { pcCommands: history } : {};
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
      // **フラグキー（Attn / SysReq）でも欄を書く。ただし施錠されていないときだけ。**
      //
      // **そのキー自身のレコードは変わらない**——`buildFlagRecord` は画面の MDT を載せないので、
      // Attn / SysReq として出るバイト列は 1 バイトも変わらない（ACS も Attn は本体空の
      // フラグレコード、F12 はカーソル＋AID だけ。`20260920-restore-screen-parity` research F17。
      // 変更の前後で当 PJ のワイヤも採り、同じであることを確かめた＝同 work の AC11）。
      // 書くのは**サーバー側の画面バッファに打鍵を移すため**——ACS は打鍵を表示バッファに持ち、
      // それが SAVE SCREEN の退避に入るので Attn → F12 で戻っても消えない（同 F1・F4、decisions D6）。
      //
      // ⚠ **ただし MDT は立つ**（`setFieldValue`）。その後ホストが READ IMMEDIATE(0x72) /
      // READ MDT IMMEDIATE ALT(0x83) を送ってくると、セッションは利用者の操作を待たずに
      // 応答を組むので、打ちかけの欄がそこで出る。ACS も打鍵で FFT の MDT が立つので同じはずだが、
      // **この経路は未確認**——AC11 で測ったのはフラグレコードの前後比較だけで、
      // 0x72/0x83 が来る場面は出させていない（同 work の cross 点検の指摘。test-result「未検証の穴」）。
      //
      // **施錠中に書かないのは、逃げ道を守るため。** `setField` は施錠中に `KEYBOARD_LOCKED` を
      // 投げるので、書きにいくと**逃げ道であるはずの SysReq が、未送信の入力が残っているだけで
      // 使えなくなる**（画面は打った文字を必ず添えて送ってくる）。
      // ⚠ **このとき、施錠より前に打った内容は失われる**（クライアントも施錠中は欄を落とす。
      // `session-controller.ts` の `isFlagKey` の注記）。打鍵ごとにサーバーへ送る形にしない限り
      // 残せないので、この work の範囲外とした。
      const flagKey = msg.key === "Attn" || msg.key === "SysReq";
      // **容れ物から検証する**（3270 の `onKey3270` と同じ扱い。素通しすると
      // `fields.map is not a function` が素の V8 の文言のままブラウザへ返る）
      const fields = msg.fields === undefined ? undefined : parseKeyFields(msg.fields);
      if (fields && fields.length > 0 && !(flagKey && entry.session.keyboardLocked)) {
        // **秘密の解決はフィールドを 1 つでも書く前に済ませる**（spec D11）。
        // 途中で失敗して throw すると、それまでに書いた欄だけがホストに残り、
        // 「ユーザー名は入ったがパスワードは空」という中途半端な状態で AID を待つことになる。
        //
        // `assertWritable` も**この中**に置く。いまは `assertKeyAllowed` が先に弾くので等価だが、
        // 外に出すと「読み取り専用でも逃げ道は通す」を入れた瞬間に `READ_ONLY_SESSION` で
        // Attn / SysReq がホストへ出なくなる（`20260920-restore-screen-parity` review ラウンド 3）
        const write = (): void => {
          this.deps.sessions.assertWritable(id, this.user);
          const values = fields.map((f) => this.resolveField(f as WsKeyField));
          for (const { field, value } of values) {
            entry.session.setField(typeof field === "number" ? { index: field } : field, value);
          }
        };
        if (flagKey) {
          // **フラグキーの同期は best-effort。失敗しても送信を止めない。**
          // 施錠は上で除いてあるが、`setField` は `FIELD_TYPE` / `FIELD_OVERFLOW` /
          // `FIELD_PROTECTED`・欄が見つからない・秘密の復号でも投げる。止めると
          // **「打ちかけの値が型に合わない」「ホストが画面を差し替えて欄が消えた」という
          // まさに逃げたい状況で Attn / SysReq がホストへ出ない**
          // （`20260920-restore-screen-parity` の cross 点検で発見）。
          // 書けなくても**ホストへ送るバイト列は失われない**（フラグレコードは欄を運ばない）。
          // 失うのは「Attn → F12 で戻ったときに打鍵が残るか」だけなので、送信より軽い。
          try {
            write();
          } catch (e) {
            // **例外そのものは載せない。** `setField` の検証エラーはかつて文言に**打鍵した値を埋めており**
            // （`field-validate.ts` の `JSON.stringify(value)`。`20260920-field-error-no-value` で撤去）、
            // `err` を渡すと**マクロ由来の秘密がサーバーログへ出て**いた（`AGENTS.md`「秘密の扱い」の
            // 「ログにも値を出さない」。`20260920-restore-screen-parity` review ラウンド 2 の must）。
            // **撤去後も `errShape` を通す**——ここを通る例外は `setField` だけではない。
            // `stack` も 1 行目に message を含むので、**フレームだけ**を残す
            wsLog.warn(
              { sessionId: id, key: msg.key, ...errShape(e) },
              "flag key field sync skipped"
            );
          }
        } else {
          write();
        }
      }
      // 応答画面は session の screen イベントで push される。
      // ただし表示を変えないキーではイベントが起きず、**タイムアウト復帰でも起きない**。
      // 後者では keyboardLocked が解除された画面が screen イベントに乗らないため、
      // sendAid の戻り値（解除後の画面）を key-done に必ず載せる。
      const res = await entry.session.sendAid(msg.key as AidKey, {
        ...(msg.cursor ? { cursor: msg.cursor } : {}),
        // システム要求行の文字列。SysReq 以外に付いていれば core が PROTOCOL_ERROR で弾く
        ...(msg.sysReqText !== undefined ? { sysReqText: msg.sysReqText } : {}),
        // **画面は期限を設けずに待つ。** 人が見ている端末なので、時間で諦める理由が無い
        // ——実機・ACS・tn5250j・lib5250 はどれも `X SYSTEM` を点けたまま待ち、
        // 抜ける口は Attn / SysReq のほうに置いている（`aid-response-timeout`）。
        // 30 秒で切ると、時間の掛かる CALL のたびに「応答がありません」と嘘をつき、
        // 施錠を偽って解いていた。ws は 1 通ずつ独立に処理される（`app.ts` の `void handle`）ので、
        // ここで待ち続けても**あとから来る Attn / SysReq は先に通る**
        timeoutMs: "never"
      });
      // **フラグキーには返さない。** `key-done` は「応答待ちを解く合図」で、
      // Attn / SysReq はそもそも待たない（画面側も busy に載せていない）。返すと、
      // **応答待ちの最中に押した Attn が、元の待ちの busy を解いて**しまう
      if (!flagKey) {
        this.send({ type: "key-done", sessionId: id, screen: res.screen, timedOut: res.timedOut });
      }
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
    // **形の検査を最初に置く**（`ws-field-ref.ts`。3270 の `applyFields` と同じ並びにする
    // ——片方だけ順序が違うと、同じ関数を呼んでいても片方だけ穴が残る。ラウンド 3 で実測）
    const { field, hasValue } = parseKeyFieldShape(f);
    if (hasValue) return { field, value: parseFieldValue((f as { value: unknown }).value) };
    const store = this.deps.macros;
    if (!store) {
      throw new As400Error("CONFIG_ERROR", "macro store is not configured; cannot replay macro secrets");
    }
    // ws メッセージは JSON.parse したままの生データ。**秘密を守る経路なので形を検証する**——
    // 検証せずに渡すと、壊れた参照が素の TypeError になって JS のエラー文がそのまま client へ返る
    const ref = macroSecretRefSchema.safeParse((f as { secretRef: unknown }).secretRef);
    if (!ref.success) {
      // **zod の文を出さない**——`unrecognized_keys` に**クライアントが付けたキー名**が入る
      // （`20260920-field-error-no-value` decisions D3。`code` が種別を伝えており、押した側は自分が送った値を知っている）
      throw new As400Error("PROTOCOL_ERROR", "invalid secretRef");
    }
    return { field, value: store.resolveSecret(ref.data, this.user) };
  }

  private async onGuiSelect(msg: WsClientMessage & { type: "gui-select" }): Promise<void> {
    const id = this.requireSession();
    await withAudit({ op: "ws_gui_select", sessionId: id }, async () => {
      const entry = this.deps.sessions.assertWritable(id, this.user);
      // **`fieldId` を反射しない**（`20260920-field-error-no-value` decisions D3・D8。
      // 文言は web-ui が code から作る——サーバーで日本語を組まない）
      const fieldId = parseFieldId(msg.fieldId);
      const ok = entry.session.selectGuiChoice(fieldId, msg.choiceIndex, msg.selected ?? true);
      if (!ok) throw new As400Error("FIELD_NOT_FOUND", "no such GUI selection choice");
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
      const res = await entry.session.submitGuiSelection(parseFieldId(msg.fieldId), opts);
      // **`key` と同じく完了そのものを伝える**（`onKey` の注記と同じ理由）。画面は screen
      // イベントでも届くが、施錠されたままの画面では画面側が待ちを解かないので、
      // これが無いとタイムアウト復帰で待ちが残る（GUI 選択の確定だけが取り残される）。
      this.send({ type: "key-done", sessionId: id, screen: res.screen, timedOut: res.timedOut });
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

  private dispose(reason: string, opts?: { transportLost?: boolean }): void {
    // 後始末に入った印。`onOpen` が非同期の待ち（関連付けるプリンターの起動・接続）の後に見て、誰も持たないセッションを作らない
    this.disposed = true;
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
    if (this.link) {
      // このタブのリスナー（`PrinterListener`）は上で外しているが、
      // **記録はエントリ側に溜まり続ける**ので、開き直したときに閉じている間のぶんを読める
      // （常駐プリンターを切らない理由は `session-lifetime.ts` の `decideDisposition` へ移した）。
      //
      // **後始末の処分は `SessionManager.disposition` が決めて実行する**
      // （`20260908-session-lifetime-rules-fold`）。座を返す・猶予に入れる・閉じる、の
      // どれになるかは規則（`session-lifetime.ts`）が答えるので、ここに分岐は置かない
      // ——散らすと、1 つの規則を直したときに隣の写しが別の結論を返し続ける。
      //
      // **購読はすべて上で外し終えている**のが呼び出しの前提（`hasViewer` が
      // 「自分以外」を意味するのはそのため）
      this.deps.sessions.disposition(this.link.id, {
        role: this.link.role,
        transportLost: opts?.transportLost === true
      });
      this.link = undefined;
    }
    // **`ended` は付けない。** ここはこの WS 接続の後始末で、セッションは猶予として
    // 生きていることも、他のタブが見ていることもある（`WsClosed.ended` の注記）
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

/** `opened` / `host-reconnected` に載せる起動応答のコード（`WsOpened.startupCode`。起動応答が無ければ何も載せない） */
function startupCodeOf(session: { startup?: { code: string } | undefined }): { startupCode?: string } {
  const code = session.startup?.code;
  return code ? { startupCode: code } : {};
}

/** `opened` に載せる「ホストへ繋ぎ直している最中か」（`WsOpened.hostReconnect`） */
function hostReconnectOf(session: { reconnecting?: { attempt: number } | undefined }): { hostReconnect?: { attempt: number } } {
  const r = session.reconnecting;
  return r ? { hostReconnect: r } : {};
}
