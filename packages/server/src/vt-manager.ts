import { randomUUID } from "node:crypto";
import { As400Error } from "@ts5250/base";
import { VtSession, type VtEncoding, type VtSnapshot } from "@ts5250/vt";
import { childLog } from "./log.js";

const log = childLog({ component: "vt-manager" });

/**
 * **VT セッションの保持。**
 *
 * `SessionManager`（5250）・`Tn3270Manager` とは**別に持つ**——3270 のときと同じ判断。
 * あちらの `SessionEntry.session` は `Session5250` 型で、`server` 全体と `ws-handler` が
 * その前提で書かれている。差し込むと影響が全域に及ぶ。
 *
 * ここが持たないもの（5250 側にはあるが VT では対象外。spec「対象外」）:
 * 予約・watch・PC コマンド・ジョブ情報・マクロ・自動サインオン・永続化。
 *
 * ## 配信は 1 フレームぶん溜めてから
 *
 * VT は**受信のたびに** `screen` を出す。`ls -R /` のような濁流では 1 秒に何百回も飛ぶので、
 * **16ms（1 フレーム）溜めて 1 通にまとめる**。溜めるのはここ 1 か所——購読側それぞれに
 * 書かせると、購読者が増えたときにタイマーがその数だけ走る。
 */

export interface VtEntry {
  id: string;
  session: VtSession;
  host: string;
  readOnly: boolean;
  owner?: string;
  connectedAt: string;
  encoding: VtEncoding;
  /** 画面が変わったときに呼ぶ購読者（ブラウザ 1 枚につき 1 つ） */
  subscribers: Set<(snap: VtSnapshot) => void>;
  /** タイトルが変わったときに呼ぶ購読者 */
  titleSubscribers: Set<(title: string) => void>;
  /** 閉じたときに呼ぶ購読者 */
  closeSubscribers: Set<(reason: string) => void>;
}

export interface OpenVtOptions {
  host: string;
  port?: number;
  rows?: number;
  cols?: number;
  encoding?: VtEncoding;
  /** 申告する端末タイプ。**IBM i には `["VT220"]`**（既定は xterm 系→VT 系の候補列） */
  terminalTypes?: readonly string[];
  /** IBM i にコードページを申告するための CCSID */
  ccsid?: number;
  deviceName?: string;
  scrollback?: number;
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
  readOnly?: boolean;
  owner?: string;
  connectTimeoutMs?: number;
}

/** 1 フレーム（60fps）。これ以上細かくしても画面は追いつかない */
const COALESCE_MS = 16;

export class VtManager {
  private readonly entries = new Map<string, VtEntry>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  async open(opts: OpenVtOptions): Promise<VtEntry> {
    const rows = opts.rows ?? 24;
    const cols = opts.cols ?? 80;
    if (rows < 5 || rows > 200 || cols < 20 || cols > 500) {
      throw new As400Error("CONFIG_ERROR", `画面の大きさが範囲外です（${cols}x${rows}）`);
    }
    const encoding = opts.encoding ?? "utf-8";
    const session = new VtSession({
      host: opts.host,
      port: opts.port ?? 23,
      rows,
      cols,
      encoding,
      ...(opts.terminalTypes !== undefined ? { terminalTypes: opts.terminalTypes } : {}),
      ...(opts.ccsid !== undefined ? { ccsid: opts.ccsid } : {}),
      ...(opts.deviceName !== undefined ? { deviceName: opts.deviceName } : {}),
      ...(opts.scrollback !== undefined ? { scrollback: opts.scrollback } : {}),
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {})
    });
    const entry: VtEntry = {
      id: randomUUID(),
      session,
      host: opts.host,
      readOnly: opts.readOnly ?? false,
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      connectedAt: new Date().toISOString(),
      encoding,
      subscribers: new Set(),
      titleSubscribers: new Set(),
      closeSubscribers: new Set()
    };
    // **購読は接続前に張る**——最初の画面を取りこぼさないため
    session.on("screen", () => this.schedule(entry));
    session.on("title", (t) => {
      for (const fn of entry.titleSubscribers) fn(t);
    });
    session.on("close", (reason) => {
      this.flush(entry);
      for (const fn of entry.closeSubscribers) fn(reason);
      this.entries.delete(entry.id);
    });
    session.on("error", (e) => log.warn(`vt session ${entry.id}: ${e.message}`));
    await session.open();
    this.entries.set(entry.id, entry);
    log.info(`vt session opened ${entry.id} (${opts.host}:${opts.port ?? 23} ${cols}x${rows} ${encoding})`);
    return entry;
  }

  /** 16ms ぶん溜めてから 1 通にまとめる（濁流でも毎秒 60 通で頭打ち） */
  private schedule(entry: VtEntry): void {
    if (this.timers.has(entry.id)) return;
    const t = setTimeout(() => {
      this.timers.delete(entry.id);
      this.flush(entry);
    }, COALESCE_MS);
    // **プロセスの終了を妨げない**（テストで開きっぱなしのタイマーが残ると終わらない）
    t.unref?.();
    this.timers.set(entry.id, t);
  }

  private flush(entry: VtEntry): void {
    const timer = this.timers.get(entry.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(entry.id);
    }
    if (entry.subscribers.size === 0) return;
    const snap = entry.session.snapshot();
    for (const fn of entry.subscribers) fn(snap);
  }

  /** 所有者検査つきの取得。他人のセッションは見せない */
  get(id: string, owner?: string): VtEntry {
    const e = this.entries.get(id);
    if (e === undefined) throw new As400Error("SESSION_NOT_FOUND", `session ${id} not found`);
    if (e.owner !== undefined && owner !== undefined && e.owner !== owner) {
      throw new As400Error("FORBIDDEN", `session ${id} belongs to another user`);
    }
    return e;
  }

  close(id: string): void {
    const e = this.entries.get(id);
    if (e === undefined) return;
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    e.session.close();
    e.subscribers.clear();
    e.titleSubscribers.clear();
    e.closeSubscribers.clear();
    this.entries.delete(id);
    log.info(`vt session closed ${id}`);
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  get size(): number {
    return this.entries.size;
  }
}
