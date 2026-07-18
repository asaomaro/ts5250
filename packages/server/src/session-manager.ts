import { randomUUID } from "node:crypto";
import {
  Session5250,
  PrinterSession,
  Tn5250Error,
  childLog,
  type ConnectOptions,
  type AidKey,
  type PrinterConnectOptions,
  type SpoolReport
} from "@as400web/core";
import { handleReport, type PrinterOutputConfig } from "./printer-output.js";
import { assertOwner, type AuthUser } from "./auth.js";

const printerLog = childLog({ component: "printer-output" });

export interface OpenOptions extends ConnectOptions {
  /** 閲覧専用セッション（set_fields/signon/run_steps と PageUp/Down 以外の AID を拒否） */
  readOnly?: boolean;
  /** 由来（プロファイル名 or "direct"）。list_sessions 表示用 */
  origin?: string;
  /** 所有者（認証ユーザー名）。認証時に per-user 分離で使う */
  owner?: string;
}

export interface SessionEntry {
  id: string;
  session: Session5250;
  readOnly: boolean;
  host: string;
  origin: string;
  connectedAt: string;
  lastActivity: number;
  /** 所有者（認証ユーザー名）。認証 OFF なら undefined */
  owner?: string;
}

export interface OpenPrinterOptions extends PrinterConnectOptions {
  origin?: string;
  /** サーバー側出力設定（PDF 自動蓄積・自動印刷）。プロファイル由来のみ渡す（信頼設定） */
  output?: PrinterOutputConfig;
  /** 所有者（認証ユーザー名）。認証時に per-user 分離で使う */
  owner?: string;
}

/** プリンターセッションの保持単位（受信スプールをバッファし、wait_spool の待機を解決する） */
export interface PrinterEntry {
  id: string;
  session: PrinterSession;
  host: string;
  origin: string;
  connectedAt: string;
  lastActivity: number;
  /** 所有者（認証ユーザー名）。認証 OFF なら undefined */
  owner?: string;
  /** 受信済みスプール（順） */
  reports: SpoolReport[];
  /** wait_spool が返した件数（次に返す位置） */
  delivered: number;
  /** 次のスプールを待つ待機者 */
  waiters: ((r: SpoolReport | undefined) => void)[];
}

export interface SessionManagerOptions {
  maxSessions?: number;
  /** アイドルタイムアウト（ms）。無操作でこの時間を超えたら切断。既定 30 分 */
  idleTimeoutMs?: number;
  /** 現在時刻（テスト注入用） */
  now?: () => number;
}

/** ページング系 AID（readOnly セッションでも許可する閲覧操作） */
const READONLY_ALLOWED_KEYS: ReadonlySet<AidKey> = new Set<AidKey>(["PageUp", "PageDown"]);

/**
 * 複数セッションを保持・管理する（spec「セッション管理・並行性」）。
 * MCP と WebSocket が共有する。上限・アイドルタイムアウト・readOnly ゲートを担う。
 */
export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly printers = new Map<string, PrinterEntry>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 8;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** アイドルセッションの定期掃除を開始（サーバー起動時に呼ぶ）。テストでは呼ばなくてよい */
  startIdleSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), intervalMs);
    this.sweepTimer.unref?.();
  }

  get size(): number {
    return this.sessions.size + this.printers.size;
  }

  async open(opts: OpenOptions): Promise<SessionEntry> {
    if (this.size >= this.maxSessions) {
      throw new Tn5250Error("CONNECT_FAILED", `session limit reached (${this.maxSessions})`);
    }
    const id = opts.id ?? randomUUID();
    const session = await Session5250.connect({ ...opts, id });
    const entry: SessionEntry = {
      id,
      session,
      readOnly: opts.readOnly ?? false,
      host: opts.host ?? "(injected)",
      origin: opts.origin ?? "direct",
      connectedAt: new Date(this.now()).toISOString(),
      lastActivity: this.now(),
      ...(opts.owner !== undefined ? { owner: opts.owner } : {})
    };
    this.sessions.set(id, entry);
    session.on("closed", () => this.sessions.delete(id));
    return entry;
  }

  get(id: string, user?: AuthUser): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry) throw new Tn5250Error("SESSION_NOT_FOUND", `session ${id} not found`);
    assertOwner(entry.owner, user); // 認証時は所有者/admin のみ（OFF は全通過）
    entry.lastActivity = this.now();
    return entry;
  }

  /** プリンターセッションを開く（TN5250E プリンター）。受信スプールをバッファする。 */
  async openPrinter(opts: OpenPrinterOptions): Promise<PrinterEntry> {
    if (this.size >= this.maxSessions) {
      throw new Tn5250Error("CONNECT_FAILED", `session limit reached (${this.maxSessions})`);
    }
    const session = await PrinterSession.connect({ ...opts, id: opts.id ?? randomUUID() });
    const id = session.id;
    const entry: PrinterEntry = {
      id,
      session,
      host: opts.host ?? "(injected)",
      origin: opts.origin ?? "direct",
      connectedAt: new Date(this.now()).toISOString(),
      lastActivity: this.now(),
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      reports: [],
      delivered: 0,
      waiters: []
    };
    this.printers.set(id, entry);
    session.on("report", (report) => {
      entry.reports.push(report);
      entry.lastActivity = this.now();
      const waiter = entry.waiters.shift();
      if (waiter) {
        entry.delivered = entry.reports.length;
        waiter(report);
      }
      // サーバー側出力（PDF 自動蓄積・自動印刷）。設定があるときだけ・失敗しても受信は妨げない
      if (opts.output) {
        void handleReport(report, opts.output, (m) => printerLog.warn(m)).catch((e) =>
          printerLog.warn(`printer output failed: ${e instanceof Error ? e.message : String(e)}`)
        );
      }
    });
    session.on("closed", () => {
      for (const w of entry.waiters.splice(0)) w(undefined);
      this.printers.delete(id);
    });
    return entry;
  }

  getPrinter(id: string, user?: AuthUser): PrinterEntry {
    const entry = this.printers.get(id);
    if (!entry) throw new Tn5250Error("SESSION_NOT_FOUND", `printer session ${id} not found`);
    assertOwner(entry.owner, user); // 認証時は所有者/admin のみ
    entry.lastActivity = this.now();
    return entry;
  }

  /** 認証時は所有者のセッションのみ（admin は全件）。OFF は全件。 */
  private ownedOnly<T extends { owner?: string }>(entries: T[], user?: AuthUser): T[] {
    if (!user || user.role === "admin") return entries;
    return entries.filter((e) => e.owner === user.username);
  }

  listPrinters(user?: AuthUser): PrinterEntry[] {
    return this.ownedOnly([...this.printers.values()], user);
  }

  /**
   * 次の未受け取りスプールを返す。既に届いていれば即返し、無ければ timeoutMs まで待つ。
   * タイムアウト・切断時は undefined。
   */
  waitSpool(id: string, timeoutMs = 30_000, user?: AuthUser): Promise<SpoolReport | undefined> {
    const entry = this.getPrinter(id, user);
    if (entry.delivered < entry.reports.length) {
      return Promise.resolve(entry.reports[entry.delivered++]);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = entry.waiters.indexOf(onReport);
        if (idx >= 0) entry.waiters.splice(idx, 1);
        resolve(undefined);
      }, timeoutMs);
      const onReport = (r: SpoolReport | undefined): void => {
        clearTimeout(timer);
        resolve(r);
      };
      entry.waiters.push(onReport);
    });
  }

  list(user?: AuthUser): SessionEntry[] {
    return this.ownedOnly([...this.sessions.values()], user);
  }

  /** 書き込み操作の可否を検査（readOnly なら READ_ONLY_SESSION／所有者でなければ FORBIDDEN） */
  assertWritable(id: string, user?: AuthUser): SessionEntry {
    const entry = this.get(id, user);
    if (entry.readOnly) {
      throw new Tn5250Error("READ_ONLY_SESSION", `session ${id} is read-only`);
    }
    return entry;
  }

  /** AID キーの可否を検査（readOnly は PageUp/PageDown のみ許可） */
  assertKeyAllowed(id: string, key: AidKey, user?: AuthUser): SessionEntry {
    const entry = this.get(id, user);
    if (entry.readOnly && !READONLY_ALLOWED_KEYS.has(key)) {
      throw new Tn5250Error("READ_ONLY_SESSION", `key ${key} not allowed on read-only session`);
    }
    return entry;
  }

  async close(id: string, user?: AuthUser): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry) {
      assertOwner(entry.owner, user);
      entry.session.disconnect();
      this.sessions.delete(id);
      return;
    }
    const printer = this.printers.get(id);
    if (printer) {
      assertOwner(printer.owner, user);
      printer.session.disconnect();
      this.printers.delete(id);
      return;
    }
    throw new Tn5250Error("SESSION_NOT_FOUND", `session ${id} not found`);
  }

  closeAll(): void {
    for (const entry of this.sessions.values()) entry.session.disconnect();
    this.sessions.clear();
    for (const entry of this.printers.values()) entry.session.disconnect();
    this.printers.clear();
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  private sweepIdle(): void {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [id, entry] of this.sessions) {
      if (entry.lastActivity < cutoff) {
        entry.session.disconnect();
        this.sessions.delete(id);
      }
    }
    for (const [id, entry] of this.printers) {
      if (entry.lastActivity < cutoff) {
        entry.session.disconnect();
        this.printers.delete(id);
      }
    }
  }
}
