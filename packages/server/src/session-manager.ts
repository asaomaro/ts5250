import { randomUUID } from "node:crypto";
import { As400Error } from "@as400web/base";
import { CommandConnection, listJobs } from "@as400web/hostserver";
import { Session5250, PrinterSession, type ConnectOptions, type AidKey, type PcCommandRequest, type PrinterConnectOptions, type SpoolReport } from "@as400web/core";
import { childLog } from "./log.js";
import { rescueStuckSpools, type RescueAction } from "./spool-rescue.js";
import {
  runPcCommand,
  pcCommandHostname,
  type PcCommandConfig,
  type PcCommandOutcome
} from "./pc-command.js";
import { handleReport, type PrinterOutputConfig, type HandleReportResult } from "./printer-output.js";
import { ScreenRecorder } from "./screen-recorder.js";
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

/** PC コマンドの履歴保持件数（後から画面を開いても直近の実行が分かるように残す） */
const PC_COMMAND_HISTORY = 20;

export interface OpenOptions extends ConnectOptions {
  /** 閲覧専用セッション（set_fields/signon/run_steps と PageUp/Down 以外の AID を拒否） */
  readOnly?: boolean;
  /** 由来（プロファイル名 or "direct"）。list_sessions 表示用 */
  origin?: string;
  /** 所有者（認証ユーザー名）。認証時に per-user 分離で使う */
  owner?: string;
  /**
   * 装置名が使用中でホストに拒否されたとき、末尾の数字を繰り上げて再試行する。
   *
   * **既定 off。** 装置名を固定するのは「その名前で繋ぎたい」意図なので、黙って別名に
   * すり替えるのは裏切りになる。名前にこだわらないが確実に繋ぎたい運用のための任意設定。
   */
  deviceNameRetry?: boolean;
  /**
   * 書き出しできないスプールを取得したあと、ホスト側のスプールをどうするか。
   * **既定は保留**——削除は取り消せないので、利用者が明示的に選んだときだけ行う。
   */
  rescueAction?: RescueAction;
  /**
   * PC コマンド（STRPCCMD）の実行設定。**サーバー設定由来のセッションだけが持つ**（信頼設定）。
   * 未指定なら「実行しない」。検出と実行キーの応答は設定に関わらず行われる
   * （返さないとホストが待ち続けるため。research D5）
   */
  pcCommand?: PcCommandConfig;
  /**
   * このセッションのアイドルタイムアウト（ms、または `"never"`＝切らない）。
   * 未指定ならマネージャの既定（`SessionManagerOptions.idleTimeoutMs`）に従う。
   */
  idleTimeoutMs?: IdleLimit;
}

/**
 * アイドルタイムアウトの内部表現。ms、または `"never"`（＝切らない）。
 *
 * **`0` / `null` を「切らない」の印にしない**——未設定・転記漏れと見分けが付かなくなる
 * （spec 方針2）。設定ファイル側は「分」で持ち、`idleTimeoutToMs()` でここへ変換する。
 */
export type IdleLimit = number | "never";

/**
 * 切断を通知しない入口（MCP）に使うアイドル上限（ms）。
 *
 * この値は**安全網であって設定ではない**。MCP は `StreamableHTTPTransport` のツール呼び出しごとの
 * HTTP で、クライアントが落ちても通知が来ない（research F2）。従来の既定と同じ 30 分にしてある。
 */
export const ORPHAN_IDLE_TIMEOUT_MS = 30 * 60_000;

/**
 * 切断を通知しない入口（MCP）のアイドル上限を決める。**`"never"` は通さない。**
 *
 * ブラウザ経路は WS の切断とハートビートが孤児を回収するので永続でも安全だが、
 * MCP には回収する者が居ない。永続を許すと落ちたクライアントのセッションが残り続け、
 * `maxSessions` を食い潰して新規接続ができなくなる（装置記述も掴んだまま。research F2）。
 */
export function orphanSafeIdleTimeoutMs(v: IdleLimit | undefined): number {
  return typeof v === "number" ? v : ORPHAN_IDLE_TIMEOUT_MS;
}

/** 装置名の末尾数字を繰り上げる（WEBEMU01 → WEBEMU02）。数字が無ければ 2 を足す */
export function nextDeviceName(name: string): string | undefined {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (!m) return name.length < 10 ? `${name}2` : undefined;
  const width = m[2]!.length;
  const next = Number(m[2]) + 1;
  const digits = String(next).padStart(width, "0");
  if (digits.length > width) return undefined; // 桁が増えるなら打ち止め（装置名は 10 文字まで）
  return `${m[1]}${digits}`;
}

/**
 * セッションのジョブ識別子。
 *
 * `name`（＝装置名）は**起動応答レコードから必ず取れる**（資格情報も往復も要らない）。
 * `user` / `number` はコマンドサーバーで引けたときだけ入る
 * （20260723-session-job-info-rework の research F1・F2）。
 */
export interface SessionJob {
  name: string;
  system?: string;
  user?: string;
  number?: string;
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
  /** ジョブ識別子。接続直後に装置名だけ入り、引けたら user/number が足される */
  job?: SessionJob;
  /** PC コマンド（STRPCCMD）の実行が有効か。UI の出し分けに使う */
  pcCommandEnabled: boolean;
  /** PC コマンドの実行履歴（新しい順ではなく受信順。上限 `PC_COMMAND_HISTORY`） */
  pcCommands: PcCommandEvent[];
  /** 実行状況の push フック（ws-handler が設定し、切断で解除する） */
  onPcCommandEvent?: (e: PcCommandEvent) => void;
  /**
   * 画面履歴の記録（**頼まれたときだけ**動く）。エビデンス HTML を束ねるために使う。
   * 常時記録しないのは、使わない画面でメモリを食い続けるうえ、画面に写る入力値が
   * 黙って溜まるため（`screen-recorder.ts`）。
   */
  recorder?: ScreenRecorder;
  /**
   * ジョブ識別子の解決（背後で走る）。**接続を待たせないので await しない**。
   * 呼び出し側が「取れたら表示に足す」ために購読できるよう、Promise だけ持たせる。
   * 解決できなければ `undefined` で終わる（失敗は握りつぶす）
   */
  jobResolved?: Promise<SessionJob | undefined>;
  /** このセッションのアイドルタイムアウト（`OpenOptions` 由来）。無ければマネージャ既定 */
  idleTimeoutMs?: IdleLimit;
}

/** PC コマンド 1 件の状況。開始時（`outcome` 無し）と完了時の 2 回積まれる */
export interface PcCommandEvent {
  at: number;
  command: string;
  wait: boolean;
  /** 実行先の機械名（サーバープロセスが動いている側） */
  hostname: string;
  outcome?: PcCommandOutcome;
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
  /**
   * 装置名が使用中でホストに拒否されたとき、末尾の数字を繰り上げて再試行する。
   *
   * **既定 off。** 装置名を固定するのは「その名前で繋ぎたい」意図なので、黙って別名に
   * すり替えるのは裏切りになる。名前にこだわらないが確実に繋ぎたい運用のための任意設定。
   */
  deviceNameRetry?: boolean;
  /**
   * 書き出しできないスプールを取得したあと、ホスト側のスプールをどうするか。
   * **既定は保留**——削除は取り消せないので、利用者が明示的に選んだときだけ行う。
   */
  rescueAction?: RescueAction;
  /**
   * このプリンターセッションのアイドルタイムアウト（ms、または `"never"`）。
   * 未指定ならマネージャの既定に従う。
   */
  idleTimeoutMs?: IdleLimit;
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
  /**
   * 帳票の push フック（ws-handler が設定し、切断で解除する）。
   *
   * **救出した帳票はセッションのイベントに乗らない**——ホストから届いたものではないため。
   * ws-handler が `session.on("report")` だけを見ていると救出分が画面に出ないので、
   * 配る側（`deliverReport`）から必ずこのフックを叩く。
   */
  onReport?: (r: SpoolReport) => void;
  /** 書き出しできないスプールを拾う見張り（`startRescue`）。切断で止める */
  rescueTimer?: ReturnType<typeof setInterval> | undefined;
  /** 見張りが実行中か。前回が終わる前に次を走らせて二重取得しないための鍵 */
  rescueBusy?: boolean;
  /** スプールごとの自動出力の結果（受信順・上限あり）。成功も含めて画面に出す */
  outputStatuses: SpoolOutputStatus[];
  /** 結果の push フック（ws-handler が設定し、切断で解除する） */
  onOutputStatus?: (s: SpoolOutputStatus) => void;
  /** このセッションのアイドルタイムアウト（`OpenPrinterOptions` 由来）。無ければマネージャ既定 */
  idleTimeoutMs?: IdleLimit;
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
  /**
   * アイドルタイムアウトの既定（ms、または `"never"`＝切らない）。**既定 `"never"`**。
   * エントリ個別の値（`OpenOptions.idleTimeoutMs`）が無いときに使う。
   *
   * **既定が永続なのは意図的。** WS の切断（`ws-handler.onSocketClose`）とハートビートが
   * 孤児を回収するので、壁時計タイマーは重複した安全網でしかない。一方でこのタイマーは
   * **WS が繋がったまま＝在席している利用者**を切っていた（research F1）。加えて、アイドル対話
   * ジョブの扱いは本来ホストの管轄（`QINACTITV`。多くの環境で `*NONE`）であり、こちらが
   * 30 分で切るのはホストの方針を先取りして上書きする行為だった。ACS も放置で切れない。
   *
   * 共有サーバーで有限に戻したい運用のために `--idle-timeout` を用意している。
   */
  idleTimeoutMs?: IdleLimit;
  /** 書き出しできないスプールを拾う見張りの間隔（ミリ秒。既定 10 秒） */
  rescueIntervalMs?: number;
  /** 現在時刻（テスト注入用） */
  now?: () => number;
  /**
   * ジョブ識別子の照会。**テストで偽の応答を差し込むための口**。
   *
   * 既定はコマンドサーバー（`QGYOLJOB`）。これが無いと
   * 「1 件のときだけ採用」「資格情報が無ければ引かない」といった判断を、
   * 実機なしでは一切テストできない（host-ifs の `connect` と同じ考え方）。
   */
  lookupJobs?: LookupJobs;
}

/** 装置名とユーザーで対話ジョブを引く。返すのは一致したジョブ（0 件・複数件もありうる） */
export type LookupJobs = (
  target: { host: string; user: string; password: string; tls?: ConnectOptions["tls"] },
  filter: { name: string; user: string }
) => Promise<{ name: string; user: string; number: string }[]>;

/** 既定の照会: コマンドサーバーに繋いで QGYOLJOB を引き、使い終わったら閉じる */
const lookupJobsViaCommandServer: LookupJobs = async (target, filter) => {
  const conn = await CommandConnection.connect({
    host: target.host,
    user: target.user,
    password: target.password,
    ...(target.tls !== undefined ? { tls: target.tls } : {})
  });
  try {
    // 種別 I（対話）まで絞る。装置名だけでは**他人のジョブを掴む**（research F2）
    return await listJobs(conn, { ...filter, type: "I" }, { max: 5 });
  } finally {
    conn.close();
  }
};

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
  private readonly idleTimeoutMs: IdleLimit;
  /** 書き出しできないスプールを拾う見張りの間隔（既定 10 秒） */
  private readonly rescueIntervalMs: number;
  private readonly now: () => number;
  private readonly lookupJobs: LookupJobs;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SessionManagerOptions = {}) {
    this.maxSessions = opts.maxSessions ?? 8;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? "never";
    this.rescueIntervalMs = opts.rescueIntervalMs ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
    this.lookupJobs = opts.lookupJobs ?? lookupJobsViaCommandServer;
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
      // **繋ぎに行く前に自分側で断っている。** CONNECT_FAILED（＝ホストへ繋げなかった）と
      // 混ぜると「ホストが落ちている」と「席が空いていない」が区別できない
      throw new As400Error("SESSION_LIMIT", `session limit reached (${this.maxSessions})`);
    }
    const id = opts.id ?? randomUUID();
    // 表示セッションの警告は既定で捨てられる（core の warn 既定が no-op）。
    // 配線しないと `unknown command 0x..` すら残らず、切り分け不能になる。
    // PC コマンド（STRPCCMD）。**検出と応答は常に行い、実行だけを設定で絞る**——
    // 応答を返さないとホストは待ち続ける（research D5）。設定が無ければ disabled として記録する
    const pcCommand = (cmd: PcCommandRequest): Promise<void> => this.handlePcCommand(id, cmd, opts.pcCommand);
    const connect = (deviceName?: string): Promise<Session5250> =>
      Session5250.connect({
        ...opts,
        ...(deviceName !== undefined ? { deviceName } : {}),
        id,
        warn: (m) => sessionLog.warn({ sessionId: id }, m),
        onPcCommand: pcCommand,
        traceRecords: traceRecordsEnabled()
      });
    let session: Session5250;
    try {
      session = await connect();
    } catch (err) {
      // 装置名の重複はホストが理由を返さずソケットを閉じる。設定で許されていれば名前を繰り上げて再試行
      if (!opts.deviceNameRetry || opts.deviceName === undefined) throw err;
      session = await this.retryWithNextDeviceName(opts.deviceName, connect, err);
    }
    const entry: SessionEntry = {
      id,
      session,
      readOnly: opts.readOnly ?? false,
      host: opts.host ?? "(injected)",
      origin: opts.origin ?? "direct",
      connectedAt: new Date(this.now()).toISOString(),
      lastActivity: this.now(),
      pcCommandEnabled: opts.pcCommand?.enabled === true,
      pcCommands: [],
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {})
    };
    // 起動応答レコードから分かる範囲（装置名＝ジョブ名・システム名）を先に載せる。
    // **追加の往復はゼロ**で、資格情報が無い環境でもここまでは必ず出せる
    const startup = session.startup;
    if (startup?.device) {
      entry.job = { name: startup.device, ...(startup.system ? { system: startup.system } : {}) };
    }
    this.sessions.set(id, entry);
    session.on("closed", () => this.sessions.delete(id));
    // 残り（ユーザー・番号）はコマンドサーバーで引く。**接続を待たせない**
    entry.jobResolved = this.resolveJob(entry, opts);
    return entry;
  }

  /**
   * PC コマンド（STRPCCMD）1 件を処理する。**投げない**——例外にすると core 側が
   * ホストへ実行キーを返す前に抜ける恐れがあり、ホストが待ち続ける（research D5）。
   *
   * 開始と完了の 2 回イベントを積む。`PAUSE(*NO)` は「起動した」で完了扱いになる。
   */
  private async handlePcCommand(
    id: string,
    cmd: PcCommandRequest,
    cfg: PcCommandConfig | undefined
  ): Promise<void> {
    const host = pcCommandHostname();
    const begin: PcCommandEvent = { at: this.now(), command: cmd.command, wait: cmd.wait, hostname: host };
    this.pushPcCommandEvent(id, begin);
    sessionLog.info(
      { sessionId: id, command: cmd.command, wait: cmd.wait, hostname: host },
      "PC command received from host"
    );
    let outcome: PcCommandOutcome;
    try {
      outcome = await runPcCommand(cmd, cfg);
    } catch (err) {
      outcome = {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: this.now() - begin.at
      };
    }
    sessionLog.info({ sessionId: id, command: cmd.command, outcome }, "PC command finished");
    this.pushPcCommandEvent(id, { ...begin, at: this.now(), outcome });
  }

  private pushPcCommandEvent(id: string, event: PcCommandEvent): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.pcCommands.push(event);
    if (entry.pcCommands.length > PC_COMMAND_HISTORY) entry.pcCommands.shift();
    entry.onPcCommandEvent?.(event);
  }

  /**
   * ジョブ識別子（ユーザー・番号）をコマンドサーバーで引く。
   *
   * **資格情報が無ければ何もしない**——画面で手サインオンする使い方では誰のジョブか分からず、
   * 装置名だけで引くと**他人のジョブを掴む**（実機で同名ジョブが 2 件返った。research F2）。
   * 失敗は握りつぶす。ジョブ情報はセッションの成立条件ではない。
   */
  private async resolveJob(
    entry: SessionEntry,
    opts: OpenOptions
  ): Promise<SessionJob | undefined> {
    const device = entry.job?.name;
    if (!device || opts.user === undefined || opts.password === undefined) return undefined;
    const host = opts.host;
    if (host === undefined) return undefined;
    try {
      const jobs = await this.lookupJobs(
        {
          host,
          user: opts.user,
          password: opts.password,
          ...(opts.tls !== undefined ? { tls: opts.tls } : {})
        },
        { name: device, user: opts.user }
      );
      // **1 件に定まらなければ採用しない**（他人のジョブを出さない。research F2）
      const only = jobs.length === 1 ? jobs[0] : undefined;
      if (!only) {
        sessionLog.debug(
          { sessionId: entry.id, device, found: jobs.length },
          "job identity not resolved (not exactly one match)"
        );
        return entry.job;
      }
      // セッションが既に閉じていれば捨てる
      if (!this.sessions.has(entry.id)) return undefined;
      entry.job = { ...entry.job, name: only.name, user: only.user, number: only.number };
      return entry.job;
    } catch (err) {
      // ホストサーバーが使えない・権限が無い等。セッションには影響させない
      sessionLog.debug(
        { sessionId: entry.id, device, err: String(err) },
        "job identity lookup failed"
      );
      return entry.job;
    }
  }

  get(id: string, user?: AuthUser): SessionEntry {
    const entry = this.sessions.get(id);
    if (!entry) throw new As400Error("SESSION_NOT_FOUND", `session ${id} not found`);
    assertOwner(entry.owner, user); // 認証時は所有者/admin のみ（OFF は全通過）
    entry.lastActivity = this.now();
    return entry;
  }

  /** プリンターセッションを開く（TN5250E プリンター）。受信スプールをバッファする。 */
  /** 装置名を繰り上げながら再試行する（既定 5 回まで）。全滅したら最初のエラーを投げ直す */
  private async retryWithNextDeviceName(
    first: string,
    connect: (deviceName: string) => Promise<Session5250>,
    original: unknown
  ): Promise<Session5250> {
    let name: string | undefined = first;
    for (let i = 0; i < 5; i++) {
      name = name === undefined ? undefined : nextDeviceName(name);
      if (name === undefined) break;
      try {
        const s = await connect(name);
        sessionLog.warn({ deviceName: name }, `装置名 ${first} が使用中のため ${name} で接続した`);
        return s;
      } catch {
        // 次の名前へ
      }
    }
    throw original;
  }

  async openPrinter(opts: OpenPrinterOptions): Promise<PrinterEntry> {
    if (this.size >= this.maxSessions) {
      throw new As400Error("SESSION_LIMIT", `session limit reached (${this.maxSessions})`);
    }
    const session = await PrinterSession.connect({ ...opts, id: opts.id ?? randomUUID() });
    // ホスト変換で受けているなら、自動印刷は PDF に起こさず受信バイトをそのまま流す
    const output =
      opts.output && opts.transformTo !== undefined
        ? { ...opts.output, rawPrint: true }
        : opts.output;
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
      ...(output !== undefined ? { output } : {}),
      outputEnabled: true, // 既定は有効（設定があれば従来どおり自動出力）
      outputWarnings: [],
      outputStatuses: [],
      ...(opts.idleTimeoutMs !== undefined ? { idleTimeoutMs: opts.idleTimeoutMs } : {})
    };
    this.printers.set(id, entry);
    session.on("report", (report) => this.deliverReport(entry, report));
    session.on("closed", () => {
      for (const w of entry.waiters.splice(0)) w(undefined);
      this.printers.delete(id);
      this.stopRescue(entry);
    });
    // 書き出しプログラムが処理できないスプールを拾う見張り（装置名＝OUTQ が要る）
    this.startRescue(entry, opts);
    return entry;
  }

  /**
   * 受信した帳票を配る（push でも救出でも同じ道を通す）。
   * ここを 1 本にしておかないと、救出した帳票だけ自動出力（PDF/印刷）から漏れる。
   */
  private deliverReport(entry: PrinterEntry, report: SpoolReport): void {
    {
      entry.reports.push(report);
      entry.lastActivity = this.now();
      entry.onReport?.(report);
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
    }
  }

  /**
   * 書き出しプログラムが処理できないスプールを拾う見張りを回す。
   *
   * **装置名（＝OUTQ）が分からなければ何もしない。** ホスト採番の装置名だと、どの待ち行列を
   * 見ればよいか決められないため。資格情報が無いときも同じ（pull 経路が開けない）。
   */
  private startRescue(entry: PrinterEntry, opts: OpenPrinterOptions): void {
    const outputQueue = opts.deviceName;
    if (!outputQueue || opts.host === undefined || opts.user === undefined) return;
    const connect: ConnectOptions = {
      host: opts.host,
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
      user: opts.user,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      ...(opts.ccsid !== undefined ? { spoolCcsid: opts.ccsid } : {})
    };
    const tick = (): void => {
      if (entry.rescueBusy) return; // 前回が終わっていなければ見送る（重複取得を避ける）
      entry.rescueBusy = true;
      void rescueStuckSpools(connect, outputQueue, opts.rescueAction ? { action: opts.rescueAction } : {})
        .then((found) => {
          for (const r of found) {
            // push 型と同じ形の帳票にして同じ道で配る。利用者からは区別が要らない
            this.deliverReport(entry, {
              id: `spool-rescued-${r.entry.fileName}-${r.entry.fileNumber}`,
              pages: r.pages,
              raw: new Uint8Array(0) // pull 経路は SCS 生バイトを持たない
            });
          }
        })
        .catch((err: unknown) => sessionLog.warn({ sessionId: entry.id, err }, "スプール救出に失敗した"))
        .finally(() => {
          entry.rescueBusy = false;
        });
    };
    const timer = setInterval(tick, this.rescueIntervalMs);
    timer.unref?.();
    entry.rescueTimer = timer;
  }

  private stopRescue(entry: PrinterEntry): void {
    if (entry.rescueTimer) {
      clearInterval(entry.rescueTimer);
      entry.rescueTimer = undefined;
    }
  }

  getPrinter(id: string, user?: AuthUser): PrinterEntry {
    const entry = this.printers.get(id);
    if (!entry) throw new As400Error("SESSION_NOT_FOUND", `printer session ${id} not found`);
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
      throw new As400Error("READ_ONLY_SESSION", `session ${id} is read-only`);
    }
    return entry;
  }

  /** AID キーの可否を検査（readOnly は PageUp/PageDown のみ許可） */
  assertKeyAllowed(id: string, key: AidKey, user?: AuthUser): SessionEntry {
    const entry = this.get(id, user);
    if (entry.readOnly && !READONLY_ALLOWED_KEYS.has(key)) {
      throw new As400Error("READ_ONLY_SESSION", `key ${key} not allowed on read-only session`);
    }
    return entry;
  }

  async close(id: string, user?: AuthUser): Promise<void> {
    const entry = this.sessions.get(id);
    if (entry) {
      assertOwner(entry.owner, user);
      entry.recorder?.stop(); // 購読を残したままセッションを捨てるとリークする
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
    throw new As400Error("SESSION_NOT_FOUND", `session ${id} not found`);
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

  /**
   * 在席の証拠を受けて `lastActivity` を進める（表示・プリンターの両方）。
   *
   * 利用者が入力欄に文字を打っても、値はブラウザ内の `edits` に溜まるだけで
   * **AID キーを押すまで WS に何も流れない**。読んでいる時間・カーソル移動も同じで、
   * サーバーからは無操作に見える。有限値を設定したときに「設定した時間より早く切れる」のを
   * 塞ぐための口（spec 方針4。通知そのものは値を運ばない）。
   *
   * **所有者検査をしない**のは、id が呼び出し元（WS 接続）自身が開いたものに限られ、
   * クライアントから来た値ではないため。存在しない id は黙って無視する
   * （既に閉じたセッションへの遅延メッセージ）。
   */
  touch(id: string): void {
    const entry = this.sessions.get(id) ?? this.printers.get(id);
    if (entry) entry.lastActivity = this.now();
  }

  /**
   * アイドル超過のセッションを切る。**判定はエントリごと**——マネージャ共通の cutoff を
   * 1 つ作って全部と比べると、セッション設定の値が効かない。
   * `"never"`（永続）のエントリは対象外。
   */
  private sweepIdle(): void {
    const now = this.now();
    const expired = (entry: { lastActivity: number; idleTimeoutMs?: IdleLimit }): boolean => {
      const limit = entry.idleTimeoutMs ?? this.idleTimeoutMs;
      return limit !== "never" && entry.lastActivity < now - limit;
    };
    for (const [id, entry] of this.sessions) {
      if (expired(entry)) {
        entry.session.disconnect();
        this.sessions.delete(id);
      }
    }
    for (const [id, entry] of this.printers) {
      if (expired(entry)) {
        entry.session.disconnect();
        this.printers.delete(id);
      }
    }
  }
}
