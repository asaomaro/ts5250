/**
 * **サービス型の常駐ジョブを持つレジストリ。** 今回入れるのはデータ待ち行列の監視
 * （`kind: "dtaq"`）1 種だけ。
 *
 * ## なぜ `SessionManager` に相乗りさせないか（spec 方針1）
 *
 * `SessionManager` の寿命の規則は「WS 切断＝破棄」「アイドルで掃除」で、
 * `20260729-session-lifetime-timeout` で整理したばかり。監視は
 *
 * - **何も来ない状態が正常**（アイドル掃除の概念が合わない）
 * - **WS とは無関係に生き続ける**（ブラウザを閉じても監視は続く。requirement）
 * - 装置名も画面も持たない
 *
 * ので、同じ箱に入れると規則に例外が生える。**寿命の異なるものを同じ箱に入れない。**
 *
 * ## 寿命
 *
 * 止まるのは**明示停止**か**プロセス終了**だけ。WS 切断でも、タブを閉じても、
 * 利用者がログアウトしても止めない（設定が仕事をするサービス型なので、
 * 「ログアウトしたら帳票が来なくなる」のと同じ違和感を避ける）。
 *
 * ## 待ち方
 *
 * `read({ wait: -1 })` で**無通信のままブロックして待つ**（ポーリングしない）。
 * `wait < 0` は read タイムアウトを無効にするので、**相手が黙って消えても永久に待つ**——
 * それを検出するために core 側で TCP キープアライブを入れてある
 * （`transport/host-connection.ts`）。切れたらここが指数バックオフで張り直す。
 */
import { randomUUID } from "node:crypto";
import { As400Error } from "@as400web/base";
import { type DtaqConnection, dtaqDecodeEbcdic } from "@as400web/hostserver";
import { type ConnectOptions } from "@as400web/core";
import { assertOwner, type AuthUser } from "./auth.js";
import type { DtaqWatchSpec } from "./config-types.js";
import { fromBytes, toBytes, type DtaqEncoding } from "./host-dtaq.js";
import { openDtaq } from "./host-connect.js";
import { childLog } from "./log.js";

const log = childLog({ component: "watch-registry" });

/** 監視 1 本の状態。**停止と障害を区別する**（requirement「黙って止まらない」） */
export type WatchState = "watching" | "reconnecting" | "error";

/** API / WS へ出す監視 1 本 */
export interface WatchView {
  id: string;
  /** サービス型の種類。今は `"dtaq"` だけ（プリンターの常駐化は別作業） */
  kind: "dtaq";
  /** 由来のセッション設定参照（`srv:` / `own:`） */
  ref: string;
  /** 表示名（`ライブラリー/キュー`） */
  label: string;
  state: WatchState;
  /** `state === "error"` のときの理由（利用者に見せる） */
  error?: string;
  /** 累計受信件数（履歴の上限で落ちた分も含む） */
  received: number;
  startedAt: string;
  /** 所有者（認証時）。他人には見せない */
  owner?: string;
}

/** 受信 1 件 */
export interface WatchEntryView {
  /** 監視ごとの連番（1 始まり）。履歴が落ちても番号は戻らない */
  seq: number;
  at: number;
  /** 本文（`encoding` で解いた文字列。`base64` のときは base64 文字列） */
  text: string;
  bytes: number;
  /** 送信者情報（save sender 有効なキューのみ） */
  sender?: string;
}

/** 購読者へ流すイベント */
export type WatchEvent =
  | { type: "entry"; watch: WatchView; entry: WatchEntryView }
  | { type: "state"; watch: WatchView };

export interface WatchRegistryOptions {
  /**
   * 同時監視数の上限（既定 4）。**監視 1 本＝ホストサーバー接続 1 本を占有する**
   * （待機中は他の要求を出せない）ので、無制限に張らせない。
   */
  maxWatches?: number;
  /** 履歴の保持件数（監視あたり。既定 200）。超えたら古いものから落とす */
  historyLimit?: number;
  /** 接続を開く手段。**テストで偽の接続を差し込むための口** */
  connect?: (opts: ConnectOptions) => Promise<DtaqConnection>;
  now?: () => number;
  /** 再接続の待ち（ms）。テストで縮める */
  backoffMs?: readonly number[];
  /** 待ちを挟む関数（テストで即時にする） */
  delay?: (ms: number) => Promise<void>;
}

/** 再接続の待ち（指数バックオフ。最後の値で頭打ち） */
const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/**
 * 待っても直らない失敗。**再試行せず `error` に落とす**——
 * 権限が無い・キューが無いは、何度張り直しても同じ結果になる。
 */
const FATAL_CODES = new Set([
  "ACCESS_DENIED",
  "FORBIDDEN",
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "CONFIG_ERROR",
  "HOST_SERVER_UNSUPPORTED"
]);

interface Watch {
  view: WatchView;
  spec: DtaqWatchSpec;
  connect: ConnectOptions;
  history: WatchEntryView[];
  /**
   * 明示停止の印。**ループの `catch` がこれを見て「障害ではない」と判断する**——
   * `close()` は待機中の `read` を reject するので、印が無いと停止操作が `error` 表示になる。
   *
   * `close()` の前に立てているのは並びの綺麗さだけで、**順序に依存はしていない**
   * （Promise の reject ハンドラは必ずマイクロタスクで走るので、`stop()` の同期処理が
   * 終わった時点で印は立っている）。空振り検証で順序を入れ替えても落ちないのはそのため。
   */
  stopping: boolean;
  conn?: DtaqConnection;
}

export class WatchRegistry {
  private readonly watches = new Map<string, Watch>();
  private readonly subscribers = new Set<(ev: WatchEvent) => void>();
  private readonly maxWatches: number;
  private readonly historyLimit: number;
  private readonly openConn: (opts: ConnectOptions) => Promise<DtaqConnection>;
  private readonly now: () => number;
  private readonly backoff: readonly number[];
  private readonly delay: (ms: number) => Promise<void>;

  constructor(opts: WatchRegistryOptions = {}) {
    this.maxWatches = opts.maxWatches ?? 4;
    this.historyLimit = opts.historyLimit ?? 200;
    this.openConn = opts.connect ?? openDtaq;
    this.now = opts.now ?? (() => Date.now());
    this.backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get size(): number {
    return this.watches.size;
  }

  /**
   * 監視を始める。**最初の接続だけは待つ**——権限が無い・キューが無いといった
   * 「始められない理由」は呼び出し側（＝利用者の操作）に返したい。
   * 2 回目以降の張り直しは背後で行う。
   */
  async start(opts: {
    ref: string;
    label: string;
    spec: DtaqWatchSpec;
    connect: ConnectOptions;
    owner?: string;
  }): Promise<WatchView> {
    // **同じ設定の監視を二重に始めない。** 監視は**消費する**ので、2 本掛かると
    // 1 本ぶんのエントリを取り合って両方が欠ける。
    //
    // 判定を**サーバーに置くのが要点**——画面側だけで見ると、リロード直後は
    // まだ一覧が届いておらず（`watch-list` 待ち）すり抜ける（実機 E2E で踏んだ）。
    // 既にあるならそれを返す（冪等）。呼び出し側は「監視が動いている」だけ知りたい。
    const existing = [...this.watches.values()].find(
      (w) => w.view.ref === opts.ref && w.view.owner === opts.owner
    );
    if (existing) return { ...existing.view };
    if (this.watches.size >= this.maxWatches) {
      throw new As400Error("SESSION_LIMIT", `watch limit reached (${this.maxWatches})`);
    }
    const conn = await this.openConn(opts.connect);
    const id = randomUUID();
    const watch: Watch = {
      view: {
        id,
        kind: "dtaq",
        ref: opts.ref,
        label: opts.label,
        state: "watching",
        received: 0,
        startedAt: new Date(this.now()).toISOString(),
        ...(opts.owner !== undefined ? { owner: opts.owner } : {})
      },
      spec: opts.spec,
      connect: opts.connect,
      history: [],
      stopping: false,
      conn
    };
    this.watches.set(id, watch);
    log.info({ watchId: id, label: opts.label }, "watch started");
    // ループは待たない（呼び出し側は「始まった」だけ知りたい）
    void this.loop(watch);
    return { ...watch.view };
  }

  /** 明示停止。印を立ててから接続を閉じる（印の意味は `Watch.stopping` の JSDoc） */
  stop(id: string, user?: AuthUser): void {
    const w = this.watches.get(id);
    if (!w) throw new As400Error("NOT_FOUND", `watch ${id} not found`);
    assertOwner(w.view.owner, user);
    w.stopping = true;
    w.conn?.close();
    this.watches.delete(id);
    log.info({ watchId: id }, "watch stopped");
  }

  list(user?: AuthUser): WatchView[] {
    return [...this.watches.values()]
      .filter((w) => this.canSee(w, user))
      .map((w) => ({ ...w.view }));
  }

  history(id: string, user?: AuthUser): WatchEntryView[] {
    const w = this.watches.get(id);
    if (!w) throw new As400Error("NOT_FOUND", `watch ${id} not found`);
    assertOwner(w.view.owner, user);
    return [...w.history];
  }

  /**
   * push の購読。戻り値を呼ぶと解除する。
   *
   * **`user` を渡すと、その利用者から見える監視のイベントだけが届く。**
   * 絞り込みをここで行うのは、所有の規則（`assertOwner`）が既にこのクラスにあるから
   * ——購読側で「自分のものか」を組み立て直すと規則が 2 か所になり、
   * イベントごとに一覧を作る無駄も生む。
   */
  subscribe(fn: (ev: WatchEvent) => void, user?: AuthUser): () => void {
    const sub = (ev: WatchEvent): void => {
      if (!this.canSeeView(ev.watch, user)) return;
      fn(ev);
    };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** プロセス終了時に呼ぶ（テストの後片付けにも使う） */
  closeAll(): void {
    for (const w of this.watches.values()) {
      w.stopping = true;
      w.conn?.close();
    }
    this.watches.clear();
  }

  /** 所有者から見えるか（認証オフは全通過。`assertOwner` と同じ規則） */
  private canSee(w: Watch, user?: AuthUser): boolean {
    return this.canSeeView(w.view, user);
  }

  private canSeeView(view: WatchView, user?: AuthUser): boolean {
    try {
      assertOwner(view.owner, user);
      return true;
    } catch {
      return false;
    }
  }

  private emit(ev: WatchEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(ev);
      } catch (e) {
        // 購読者 1 人の失敗で他へ配れなくならないようにする
        log.debug({ err: String(e) }, "watch subscriber threw");
      }
    }
  }

  /**
   * 監視の本体。**エントリが来るまで無通信でブロックする**。
   *
   * 停止（`stopping`）なら黙って抜ける。それ以外の失敗は
   * 致命的なら `error`、一時的なら `reconnecting` にして張り直す。
   */
  private async loop(w: Watch): Promise<void> {
    let attempt = 0;
    while (!w.stopping) {
      try {
        if (!w.conn) {
          w.conn = await this.openConn(w.connect);
          // **繋がった時点で `watching` に戻す。** 受信できたときに戻す形だと、
          // 張り直せたのにエントリが来ないキューが永久に `reconnecting` に見える
          // ——「何も来ないのが正常」な監視では、それは嘘の表示になる
          attempt = 0;
          if (w.view.state !== "watching") this.setState(w, "watching");
        }
        const entry = await w.conn.read(this.readOptions(w.spec));
        // **空で戻るのは想定外**（wait=-1 は届くまで返らない）。念のため読み直す
        if (!entry) continue;
        this.push(w, entry);
      } catch (e) {
        if (w.stopping) return; // 停止による reject（障害ではない）
        const err = e as As400Error;
        if (FATAL_CODES.has(err.code)) {
          this.setState(w, "error", err.message);
          return; // **再試行しない**（待っても直らない）
        }
        w.conn?.close();
        delete w.conn;
        this.setState(w, "reconnecting", err.message);
        const wait = this.backoff[Math.min(attempt, this.backoff.length - 1)] ?? 30_000;
        attempt += 1;
        log.warn({ watchId: w.view.id, attempt, wait, err: err.message }, "watch reconnecting");
        await this.delay(wait);
      }
    }
  }

  /** 受信 1 件を履歴へ積んで配る。**上限を超えたら古いものから落とす**（監視は続く） */
  private push(w: Watch, entry: { data: Uint8Array; senderInfo?: Uint8Array }): void {
    w.view.received += 1;
    const encoding: DtaqEncoding = w.spec.encoding ?? "utf8";
    const view: WatchEntryView = {
      seq: w.view.received,
      at: this.now(),
      text: fromBytes(entry.data, encoding),
      bytes: entry.data.length,
      ...(entry.senderInfo !== undefined ? { sender: dtaqDecodeEbcdic(entry.senderInfo) } : {})
    };
    w.history.push(view);
    if (w.history.length > this.historyLimit) w.history.splice(0, w.history.length - this.historyLimit);
    this.emit({ type: "entry", watch: { ...w.view }, entry: view });
  }

  private setState(w: Watch, state: WatchState, error?: string): void {
    w.view.state = state;
    if (state === "error" && error !== undefined) w.view.error = error;
    else delete w.view.error;
    this.emit({ type: "state", watch: { ...w.view } });
  }

  /**
   * `read` の引数。**待機は常に無限**（`wait: -1`）——常駐監視の本体で、
   * HTTP ルートの「無限待ち禁止」はここには適用しない（spec の非機能要件）。
   */
  private readOptions(spec: DtaqWatchSpec): Parameters<DtaqConnection["read"]>[0] {
    const keyEncoding: DtaqEncoding = spec.encoding ?? "utf8";
    return {
      name: spec.name,
      library: spec.library,
      wait: -1,
      ...(spec.key !== undefined ? { key: toBytes(spec.key, keyEncoding) } : {}),
      ...(spec.search !== undefined ? { search: spec.search } : {})
    };
  }
}
