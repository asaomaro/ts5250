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
import { As400Error } from "@ts5250/base";
import { type DtaqConnection, dtaqDecodeEbcdic } from "@ts5250/hostserver";
import { type ConnectOptions } from "@ts5250/tn5250";
import { assertOwner, type AuthUser } from "./auth.js";
import type { ServiceState } from "./service-state.js";
import type { DtaqWatchSpec } from "./config-types.js";
import { fromBytes, toBytes, type DtaqEncoding } from "./host-dtaq.js";
import { openDtaq } from "./host-connect.js";
import { childLog } from "./log.js";

const log = childLog({ component: "watch-registry" });

/**
 * 監視 1 本の状態。**停止と障害を区別する**（requirement「黙って止まらない」）。
 *
 * **プリンターと共有する語彙**（`service-state.ts`。`20260801-service-start-stop`）——
 * 別々の文字列を持たせると、同じことを表す語が 2 つになって UI が二重になる。
 * かつて `watching` と呼んでいたものが `listening`。
 */
export type WatchState = ServiceState;

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
  /**
   * **定義が変わったが、いまの接続には効いていない**（`20260801-service-reconcile`）。
   * 開始し直せば消える（材料は差し替え済み）。プリンターと同じ扱い。
   */
  stale?: boolean;
  /**
   * **転送を諦めた件数**（`20260801-dtaq-webhook`）。
   *
   * **監視は消費する**ので、これは「失われたデータの数」である。0 でないなら
   * 画面で目立たせる必要がある——黙って消えたと気づかないのが一番悪い。
   */
  undelivered?: number;
  /** 転送が設定されているか（中身＝URL は出さない） */
  hasWebhook?: boolean;
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
/**
 * 届いたエントリの転送先（`20260801-dtaq-webhook`）。
 *
 * **`deliver` は投げない・待たない。** 呼ぶのはキューの読み取りループなので、
 * ここで待つと受け手の遅さがホストの読み取りを塞ぎ、キューが溢れる。
 */
export interface WatchSink {
  deliver(entry: WatchEntryView, label: string): void;
  stop(): void;
  readonly stats: { failed: number; pending: number };
}

export type WatchEvent =
  | { type: "entry"; watch: WatchView; entry: WatchEntryView }
  | { type: "state"; watch: WatchView }
  /**
   * 一覧そのものが変わった（定義の追加・削除・差し替え）。
   * **行が増減する変化は `state` では伝わらない**ので別に要る
   * （`20260801-service-reconcile`）。
   */
  | { type: "list" };

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
  /** 転送先（設定があるときだけ）。**HTTP の都合はこちらに閉じ込める** */
  sink?: WatchSink;
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
    /**
     * 届いたエントリの転送先（`20260801-dtaq-webhook`）。
     * **レジストリは HTTP を知らない**——責務は「ホストの待ち行列を読む」ことだけで、
     * 送信の再試行が混ざると両方が読みにくくなる
     */
    sink?: WatchSink;
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
    if (existing) return this.viewOf(existing);
    const view = this.register(opts);
    // **最初の接続だけは待つ**——権限が無い・キューが無いといった「始められない理由」は
    // 呼び出し側（＝利用者の操作）に返したい。2 回目以降の張り直しは背後で行う。
    //
    // **失敗しても実体は残る**（`20260801-watch-register-symmetry`）。以前は接続してから
    // 登録していたので、繋がらないと**一覧に何も出ず、理由がログにしか無かった**——
    // プリンターは登録してから開始する形（`openPrinter` ＋ `startPrinter`）なので、揃えた。
    await this.resume(view.id);
    return this.viewOf(this.watches.get(view.id)!);
  }

  /**
   * **登録だけする**（接続しない）。プリンターの `openPrinter({ autoStart: false })` に当たる。
   *
   * `stopped` で置くので、**枠を占めない**（`listeningCount` は数えない）。
   * 立ち上げるかどうかは呼び出し側が `resume` で決める——「登録する」と「待ち受ける」を
   * 分けておくと、`自動で待ち受け開始 ☐` も、失敗しても一覧に残すことも、同じ形で書ける。
   */
  register(opts: {
    ref: string;
    label: string;
    spec: DtaqWatchSpec;
    connect: ConnectOptions;
    owner?: string;
    sink?: WatchSink;
  }): WatchView {
    const id = randomUUID();
    const watch: Watch = {
      view: {
        id,
        kind: "dtaq",
        ref: opts.ref,
        label: opts.label,
        state: "stopped",
        received: 0,
        startedAt: new Date(this.now()).toISOString(),
        ...(opts.owner !== undefined ? { owner: opts.owner } : {})
      },
      spec: opts.spec,
      connect: opts.connect,
      ...(opts.sink ? { sink: opts.sink } : {}),
      history: [],
      stopping: false
    };
    if (opts.sink) watch.view.hasWebhook = true;
    this.watches.set(id, watch);
    // **ここでは配らない。** 登録は組み立ての途中で、外から見て意味を持つのは
    // このあとの状態変化（`stopped` → `listening` / `error`）のほう。
    // 一覧を配り直すのは行が増減したとき（`remove` / `update`）に任せる
    return this.viewOf(watch);
  }

  /** 明示停止。印を立ててから接続を閉じる（印の意味は `Watch.stopping` の JSDoc） */
  /**
   * 待ち受けを止める。**レジストリからは消さない**——
   * 消すと一覧から落ちて、画面から**再開できなくなる**（`20260801-service-start-stop`）。
   *
   * 接続は手放す。**仕事は失われない**——待ち行列のエントリは読むまでキューに残るので、
   * 停止は「いま消費しない」であって「取りこぼす」ではない。
   * 資源を持たないので、上限の判定からも外れる。
   */
  stop(id: string, user?: AuthUser): void {
    const w = this.watches.get(id);
    if (!w) throw new As400Error("NOT_FOUND", `watch ${id} not found`);
    assertOwner(w.view.owner, user);
    if (w.view.state === "stopped") return; // 冪等（二重に押されても壊れない）
    w.stopping = true;
    w.conn?.close();
    delete w.conn;
    // **転送は止めない。** ここで捨てるのは筋が通らない——既に読み取った
    // エントリはホスト側から消えているので、捨てれば**ただのデータの喪失**になる。
    // 「待ち受けを止める」は「これ以上読まない」であって、
    // 「読んだものを配らない」ではない（`stopPrinter` が受信済みの帳票を残すのと同じ）
    this.setState(w, "stopped");
    log.info({ watchId: id }, "watch stopped");
  }

  /**
   * **開き直しの材料を差し替える**（`20260801-service-reconcile`）。
   *
   * 定義が直されたときに呼ぶ。**いまの接続は落とさない**——動いている監視を
   * 設定の保存で切ると、その瞬間に待っているエントリの受け取りが途切れる。
   *
   * @returns いま接続を持っていたか（＝新しい設定はまだ効いていない）
   */
  update(
    id: string,
    opts: { label: string; spec: DtaqWatchSpec; connect: ConnectOptions; sink?: WatchSink }
  ): boolean {
    const w = this.watches.get(id);
    if (!w) throw new As400Error("NOT_FOUND", `watch ${id} not found`);
    w.spec = opts.spec;
    w.connect = opts.connect;
    w.view.label = opts.label;
    // **古い転送先は止めない。** 差し替えても、既に積んである未送分は配り切らせる
    // （止めると読み取り済みのデータが消える）。参照を外すだけで、自分で流し終える
    if (opts.sink) {
      w.sink = opts.sink;
      w.view.hasWebhook = true;
    } else if (w.sink) {
      delete w.sink;
      delete w.view.hasWebhook;
    }
    const running = w.view.state === "listening" || w.view.state === "reconnecting";
    if (running) w.view.stale = true;
    else delete w.view.stale;
    this.emit({ type: "list" });
    return running;
  }

  /**
   * レジストリから**消す**。定義が消えたときだけ使う——
   * `stop` が残すのは「再開できるように」であって、定義ごと無くなったものは残す理由が無い。
   * **先に `stop` を呼ぶこと**（接続を持ったまま消すと掴んだ装置が返らない）。
   */
  remove(id: string): void {
    // ここでも sink は止めない（読み取り済みのぶんは配り切る）。
    // **止めるのはプロセスを畳むとき（`closeAll`）だけ**
    this.watches.delete(id);
    this.emit({ type: "list" });
  }

  /**
   * 停止した監視を再開する。**保存してある spec と接続先で開き直す**ので、
   * 画面は id だけ知っていればよい。
   */
  async resume(id: string, user?: AuthUser): Promise<void> {
    const w = this.watches.get(id);
    if (!w) throw new As400Error("NOT_FOUND", `watch ${id} not found`);
    assertOwner(w.view.owner, user);
    if (w.view.state !== "stopped" && w.view.state !== "error") return; // 既に動いている
    if (this.listeningCount() >= this.maxWatches) {
      throw new As400Error("SESSION_LIMIT", `watch limit reached (${this.maxWatches})`);
    }
    w.stopping = false;
    // ここから張る接続は**差し替え済みの材料**を使う。もう「効いていない」ではない
    delete w.view.stale;
    try {
      w.conn = await this.openConn(w.connect);
    } catch (e) {
      // **開始の失敗は状態に残す。** 例外だけだと、画面を開いていない間の失敗が消える
      // （`SessionManager.startPrinter` と同じ扱い）
      this.setState(w, "error", e instanceof Error ? e.message : String(e));
      throw e;
    }
    this.setState(w, "listening");
    log.info({ watchId: id, label: w.view.label }, "watch resumed");
    void this.loop(w);
  }

  /**
   * **待ち受け中の数**（停止中・障害は数えない）。
   * 停止中はホストへの接続を持たないので、枠を占める理由が無い。
   */
  private listeningCount(): number {
    let n = 0;
    for (const w of this.watches.values()) if (w.view.state !== "stopped" && w.view.state !== "error") n++;
    return n;
  }

  list(user?: AuthUser): WatchView[] {
    return [...this.watches.values()].filter((w) => this.canSee(w, user)).map((w) => this.viewOf(w));
  }

  /**
   * 表示用の写し。**転送の実績はここで読む**（`20260801-dtaq-webhook`）。
   *
   * 到着時に写しておく形だと、**次のエントリが来るまで数が古いまま**になる——
   * 受け手が落ちて諦めたのに、キューが静かだと「未達 0 件」に見え続ける。
   * 失敗は「何も起きない」ときにこそ起きるので、**読むたびに聞く**のが正しい
   * （実機検証でここを踏んだ）。
   */
  private viewOf(w: Watch): WatchView {
    const view = { ...w.view };
    if (w.sink) {
      const failed = w.sink.stats.failed;
      if (failed > 0) view.undelivered = failed;
      else delete view.undelivered;
    }
    return view;
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
      // **一覧の変化は誰にでも配る。** 中身は載っていないので絞る対象が無く、
      // 受け取った側は自分に見える一覧を引き直すだけ（`list(user)` が絞る）
      if (ev.type !== "list" && !this.canSeeView(ev.watch, user)) return;
      fn(ev);
    };
    this.subscribers.add(sub);
    return () => this.subscribers.delete(sub);
  }

  /** プロセス終了時に呼ぶ（テストの後片付けにも使う） */
  closeAll(): void {
    for (const w of this.watches.values()) {
      w.stopping = true;
      // **ここが唯一の捨てどころ。** プロセスが畳まれるので配り切れない
      // （未送分はここで失われる。設定画面と文書に明記してある。design D1）
      w.sink?.stop();
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
          // **繋がった時点で `listening` に戻す。** 受信できたときに戻す形だと、
          // 張り直せたのにエントリが来ないキューが永久に `reconnecting` に見える
          // ——「何も来ないのが正常」な監視では、それは嘘の表示になる
          attempt = 0;
          if (w.view.state !== "listening") this.setState(w, "listening");
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
    // **転送は待たない。** 受け手の遅さでホストの読み取りを塞がない
    // （塞ぐとキューが溢れ、受け手の障害がホスト側の業務の障害になる）
    // **数は写し取らない**（`viewOf` が読むたびに聞く）——静かなキューで諦めが起きたとき、
    // 次の到着まで古い数が残ってしまう
    w.sink?.deliver(view, w.view.label);
    this.emit({ type: "entry", watch: this.viewOf(w), entry: view });
  }

  private setState(w: Watch, state: WatchState, error?: string): void {
    w.view.state = state;
    if (state === "error" && error !== undefined) w.view.error = error;
    else delete w.view.error;
    this.emit({ type: "state", watch: this.viewOf(w) });
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
