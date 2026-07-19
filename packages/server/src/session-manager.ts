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
import { handleReport, type PrinterOutputConfig, type HandleReportResult } from "./printer-output.js";
import { assertOwner, type AuthUser } from "./auth.js";

const printerLog = childLog({ component: "printer-output" });
const sessionLog = childLog({ component: "session-5250" });

/**
 * 受信レコードを hex でログへ流すか（`AS400_TRACE_RECORDS=1` / `--trace-records`）。**障害切り分け専用**。
 * 画面の中身がログに残るので常用しない。
 *
 * **セッションを開くたびに評価する。** モジュール読み込み時に固定すると、
 * main が引数を解釈して環境変数を立てるより先に評価され、フラグが効かない。
 */
function traceRecordsEnabled(): boolean {
  return process.env.AS400_TRACE_RECORDS === "1";
}

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

/** 管理者画面向けのセッション要約（表示/プリンター統合） */
export interface SessionSummary {
  id: string;
  kind: "display" | "printer";
  owner?: string;
  host: string;
  origin: string;
  connectedAt: string;
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
  /** サーバー側出力設定（プロファイル由来）。未設定なら自動出力機能なし */
  output?: PrinterOutputConfig;
  /** 実行時の自動出力 有効/無効（既定 true）。false の間は PDF 保存・自動印刷をしない */
  outputEnabled: boolean;
  /** 直近の出力警告（上限 20 件）。後から画面を開いても直近の失敗が分かるよう保持する */
  outputWarnings: { at: number; message: string }[];
  /** 警告の push フック（ws-handler が設定し、切断で解除する） */
  onOutputWarn?: (w: { at: number; message: string }) => void;
  /** スプールごとの自動出力の結果（受信順・上限あり）。成功も含めて画面に出す */
  outputStatuses: SpoolOutputStatus[];
  /** 結果の push フック（ws-handler が設定し、切断で解除する） */
  onOutputStatus?: (s: SpoolOutputStatus) => void;
}

/**
 * 1 スプールに対する自動出力の結果。
 * 設定が無い側は**キーごと省略**する（＝「設定なし」。`ok:false`＝失敗と区別する）。
 */
export interface SpoolOutputStatus {
  spoolId: string;
  at: number;
  /** 自動出力が無効（トグル OFF）でスキップした */
  skipped?: boolean;
  pdf?: { ok: boolean; path?: string; error?: string };
  print?: { ok: boolean; printer?: string; error?: string };
}

/** 出力警告の保持上限（メモリ肥大の防止） */
const OUTPUT_WARN_LIMIT = 20;
/** 出力結果の保持上限 */
const OUTPUT_STATUS_LIMIT = 100;

/**
 * handleReport の結果を UI 表示用のステータスに変換する。
 * **設定がある側だけキーを付ける**（設定なし＝キー省略、失敗＝ok:false）。
 */
function buildOutputStatus(
  spoolId: string,
  at: number,
  cfg: PrinterOutputConfig,
  r: HandleReportResult
): SpoolOutputStatus {
  const s: SpoolOutputStatus = { spoolId, at };
  if (cfg.autoPdfDir) {
    s.pdf = r.pdfPath
      ? { ok: true, path: r.pdfPath }
      : { ok: false, ...(r.pdfError !== undefined ? { error: r.pdfError } : {}) };
  }
  if (cfg.autoPrint) {
    s.print = r.printed
      ? { ok: true, printer: cfg.autoPrint }
      : { ok: false, printer: cfg.autoPrint, ...(r.printError !== undefined ? { error: r.printError } : {}) };
  }
  return s;
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
    // 表示セッションの警告は既定で捨てられる（core の warn 既定が no-op）。
    // 配線しないと `unknown command 0x..` すら残らず、切り分け不能になる。
    const session = await Session5250.connect({
      ...opts,
      id,
      warn: (m) => sessionLog.warn({ sessionId: id }, m),
      traceRecords: traceRecordsEnabled()
    });
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
      waiters: [],
      ...(opts.output !== undefined ? { output: opts.output } : {}),
      outputEnabled: true, // 既定は有効（設定があれば従来どおり自動出力）
      outputWarnings: [],
      outputStatuses: []
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
      // サーバー側出力（PDF 自動蓄積・自動印刷）。設定があり実行時に有効なときだけ。
      // 失敗しても受信は妨げず、警告はログ＋履歴＋UI push に流す（entry 参照なのでトグルが即時効く）
      if (entry.output) {
        if (entry.outputEnabled) {
          const cfg = entry.output;
          void handleReport(report, cfg, (m) => this.noteOutputWarn(entry, m))
            .then((r) => this.noteOutputStatus(entry, buildOutputStatus(report.id, this.now(), cfg, r)))
            .catch((e) => {
              const msg = `printer output failed: ${e instanceof Error ? e.message : String(e)}`;
              this.noteOutputWarn(entry, msg);
              this.noteOutputStatus(entry, {
                spoolId: report.id,
                at: this.now(),
                ...(cfg.autoPdfDir ? { pdf: { ok: false, error: msg } } : {}),
                ...(cfg.autoPrint ? { print: { ok: false, printer: cfg.autoPrint, error: msg } } : {})
              });
            });
        } else {
          // 自動出力オフ中の受信は「スキップ」として記録する（何も起きていないことを画面で示す）
          this.noteOutputStatus(entry, { spoolId: report.id, at: this.now(), skipped: true });
        }
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

  /**
   * 出力警告を記録する: サーバーログ（従来どおり）＋セッション履歴（上限あり）＋UI への push。
   * 画面から失敗に気づけるようにするための単一経路。
   */
  private noteOutputWarn(entry: PrinterEntry, message: string): void {
    printerLog.warn(message);
    const w = { at: this.now(), message };
    entry.outputWarnings.push(w);
    if (entry.outputWarnings.length > OUTPUT_WARN_LIMIT) entry.outputWarnings.shift();
    entry.onOutputWarn?.(w);
  }

  /** 自動出力の結果を記録して UI へ push する（成功も含めて画面に出すため） */
  private noteOutputStatus(entry: PrinterEntry, status: SpoolOutputStatus): void {
    entry.outputStatuses.push(status);
    if (entry.outputStatuses.length > OUTPUT_STATUS_LIMIT) entry.outputStatuses.shift();
    entry.onOutputStatus?.(status);
  }

  /** 自動出力（PDF 保存・自動印刷）の実行時 有効/無効を切り替える（所有者/admin のみ） */
  setPrinterOutputEnabled(id: string, enabled: boolean, user?: AuthUser): PrinterEntry {
    const entry = this.getPrinter(id, user);
    entry.outputEnabled = enabled;
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

  /** 全セッション（表示＋プリンター）の要約。管理者画面用（所有者含む）。 */
  listAll(): SessionSummary[] {
    const disp: SessionSummary[] = [...this.sessions.values()].map((e) => ({
      id: e.id,
      kind: "display",
      host: e.host,
      origin: e.origin,
      connectedAt: e.connectedAt,
      ...(e.owner !== undefined ? { owner: e.owner } : {})
    }));
    const prt: SessionSummary[] = [...this.printers.values()].map((e) => ({
      id: e.id,
      kind: "printer",
      host: e.host,
      origin: e.origin,
      connectedAt: e.connectedAt,
      ...(e.owner !== undefined ? { owner: e.owner } : {})
    }));
    return [...disp, ...prt];
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
