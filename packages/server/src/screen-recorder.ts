import type { ScreenSnapshot, Session5250 } from "@as400web/core";
import type { ScreenHistoryEntry } from "@as400web/core";

/**
 * **画面履歴のリングバッファ**（自動操作のエビデンスを HTML に束ねるための記録）。
 *
 * `Session5250` は画面が更新されるたび `screen` イベントを出しており、`ws-handler` も
 * それを購読してブラウザへ push している。ここも同じ経路に相乗りするだけで、
 * 新しい通知の仕組みは要らない。流儀は `AuditBuffer`（`audit.ts`）に合わせている。
 *
 * ## 記録は「頼まれたときだけ」
 *
 * 全セッションを常時記録すると、**使いもしない画面のためにメモリを食い続ける**うえ、
 * 画面には利用者が打った値がそのまま写るので**秘密が黙って溜まる**。だから
 * 明示的に `start()` されるまで購読しない。
 *
 * ## 残さないもの
 *
 * `ScreenSnapshot` と直前に送った AID キーだけを持つ。**フィールドの入力値は持たない**
 * （監査ログがフィールド値を記録しない方針と揃える）。非表示欄は `nonDisplay` として
 * スナップショットの時点で既に伏せられている。
 */
export class ScreenRecorder {
  private readonly frames: ScreenHistoryEntry[] = [];
  private listener: ((snap: ScreenSnapshot) => void) | undefined;
  /** 次の画面に添える AID キー。`send_key` 等が押した直後に立てる */
  private pendingKey: string | undefined;

  /**
   * @param session 購読する対象
   * @param limit 保持する最大コマ数。あふれたら古いものから捨てる
   * @param now 記録時刻の採り方（テストで差し替える）
   */
  constructor(
    private readonly session: Session5250,
    private readonly limit = 100,
    private readonly now: () => number = () => Date.now()
  ) {}

  get recording(): boolean {
    return this.listener !== undefined;
  }

  get count(): number {
    return this.frames.length;
  }

  /**
   * 記録を開始する。**開始時点の画面を 1 コマ目として入れる**——
   * 「何をする前の画面か」が無いと、以降の遷移が何から始まったのか読めない。
   * 既に記録中なら何もしない（二重購読を作らない）。
   */
  start(): void {
    if (this.listener) return;
    this.push(this.session.snapshot());
    this.listener = (snap) => this.push(snap);
    this.session.on("screen", this.listener);
  }

  /** 記録を止めて購読を外す。**コマは捨てない**（止めてから取り出せる） */
  stop(): void {
    if (!this.listener) return;
    this.session.off("screen", this.listener);
    this.listener = undefined;
  }

  /** 次に記録する画面へ添える送信キーを予告する（押した側が呼ぶ） */
  noteKey(key: string): void {
    if (this.listener) this.pendingKey = key;
  }

  /** 記録済みのコマ（古い順）。呼び出し側は読むだけ */
  snapshotFrames(): readonly ScreenHistoryEntry[] {
    return this.frames.slice();
  }

  clear(): void {
    this.frames.length = 0;
  }

  private push(screen: ScreenSnapshot): void {
    const entry: ScreenHistoryEntry = {
      screen,
      capturedAt: new Date(this.now()).toISOString(),
      ...(this.pendingKey !== undefined ? { key: this.pendingKey } : {})
    };
    this.pendingKey = undefined;
    this.frames.push(entry);
    if (this.frames.length > this.limit) this.frames.shift();
  }
}
