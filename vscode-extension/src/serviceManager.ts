import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * バックグラウンドサービス（`packages/server`）のVSCode全体での単一起動・
 * 参照カウント方式の停止を担う。architecture.md「ロックファイルの状態遷移」の
 * stateDiagramをそのまま実装する。**`vscode`モジュールに依存しない**——パス解決
 * （dev/packaged・`globalStorageUri`等）は`extension.ts`が行い、ここには文字列で渡す。
 *
 * `packages/server`の`main()`はSIGINT/SIGTERMで`process.exit(0)`する
 * （research F3）ため、**必ず別プロセスとしてspawnする**（design.md「設計方針1」）。
 * システムに`node`が無い利用者環境でも動くよう、`ELECTRON_RUN_AS_NODE=1`を立てて
 * `process.execPath`（VSCodeが内蔵するElectronのNode）を使う（research F2）。
 */

/** ロックファイルの内容（`context.globalStorageUri/service.json`） */
export interface LockFile {
  pid: number;
  port: number;
  startedAt: string;
  /** windowId → 最終ハートビート(ISO)。空になったら誰も使っていない */
  windows: Record<string, string>;
  /** そのサーバーを起動した拡張のビルド（`ServiceManagerOptions.buildId`）。古いロックには無い */
  buildId?: string;
}

/** これより古いハートビートは陳腐化とみなす（クラッシュしたウィンドウの参照カウント残留対策） */
const STALE_MS = 90_000;
/** healthzの1回の疎通確認タイムアウト（既存ロックの再利用判定用。短め） */
const HEALTH_CHECK_TIMEOUT_MS = 1_000;
/** 新規起動時、healthzが200を返すまで待つ上限（`electron/main.cjs`の`waitForHealth`と同じ） */
const SPAWN_TIMEOUT_MS = 20_000;
/** 空きポート探索の開始番号（`electron/main.cjs`の既定と同じ） */
const PORT_SEARCH_START = 34000;

export interface ServiceManagerOptions {
  /** `context.globalStorageUri/service.json` */
  lockFilePath: string;
  /** `packages/server/dist/main.js`（dev）または`node_modules/@ts5250/server/dist/main.js`（packaged） */
  serverMainPath: string;
  /** `--web-root`に渡す値（`packages/web-ui/dist`） */
  webRootPath: string;
  /** `--connections`に渡す値（`context.globalStorageUri/connections.json`） */
  connectionsPath: string;
  /** `--secret-key-file`に渡す値（`context.globalStorageUri/.env`） */
  secretKeyFilePath: string;
  /** このVSCodeウィンドウを識別する値（`extension.ts`が`activate`時に`crypto.randomUUID()`で生成） */
  windowId: string;
  /**
   * 同梱サーバー／Web UIのビルドを識別する値（`extension.ts`が同梱物の中身から作る）。
   * **生きている既存サーバーでもビルドが違えば再利用しない**（D21）——`.vsix`の版数は据え置きのまま
   * 中身だけ変わるので、ロック（`globalStorage`。拡張を入れ直しても残る）に残った前のビルドの
   * サーバーへ繋ぐと、新しい拡張から古い画面が出る。未指定なら従来どおり（比べない）
   */
  buildId?: string;
  /** 注入可能。既定は実際に`spawn`する（テスト用に差し替える） */
  spawnServer?: (port: number) => ChildProcess;
  /** 注入可能。既定は実際に`/healthz`へfetchする */
  checkHealth?: (port: number, timeoutMs: number) => Promise<boolean>;
  /** 注入可能。既定は`Date.now`（ハートビート陳腐化判定のテスト用） */
  now?: () => number;
  /**
   * 起動した子プロセスの標準出力/標準エラーを伝える。**成否が確定する前から呼ばれる**
   * （spawn直後に配線する）。実機（Windows）でサーバーがhealthzに20秒以内に応答できず
   * `acquire()`が失敗したとき、以前は`extension.ts`側が`acquire()`の**成功後**にしか
   * stdout/stderrを配線していなかったため、起動中に子プロセスが出していたはずの診断出力
   * （エラーメッセージ含む）が誰にも読まれないままパイプの内側で失われ、「出力パネルに
   * 何も出ていない」という診断不能な報告になった。ここで配線を`acquire()`自身に移し、
   * 失敗時も含めて必ず伝える
   */
  onChildOutput?: (chunk: string) => void;
}

export class ServiceManager {
  private readonly opts: Required<Pick<ServiceManagerOptions, "spawnServer" | "checkHealth" | "now" | "onChildOutput">> &
    ServiceManagerOptions;

  constructor(options: ServiceManagerOptions) {
    this.opts = {
      ...options,
      spawnServer: options.spawnServer ?? ((port) => defaultSpawnServer(options, port)),
      checkHealth: options.checkHealth ?? defaultCheckHealth,
      now: options.now ?? (() => Date.now()),
      onChildOutput: options.onChildOutput ?? (() => undefined)
    };
  }

  /**
   * このウィンドウの参照を1つ加える。既存のロックが生きていれば再利用し、
   * 無ければ自分が起動する（design.md「振る舞いの詳細」の調停プロトコル）。
   *
   * **自分が新規に起動したときだけ`child`を返す**（再利用したときは無い）。
   * `extension.ts`は`child.stdin`等の操作にこれを使う想定は無く、単に「自分が
   * 起動したか」の判定に使う。stdout/stderrの配線自体は**`onChildOutput`経由で
   * `acquire()`自身が成否確定前から行う**（design.md「ログ」。taskcheck T7の指摘で
   * 追加——以前は`{port}`しか返さず、ログを流す経路が存在しなかった。その後、
   * 呼び出し元が成功後にしか配線しない構成だと失敗時の診断出力が失われる欠陥が
   * 実機（Windows）で見つかり、`onChildOutput`へ移した）
   */
  async acquire(): Promise<{ port: number; child?: ChildProcess }> {
    const existing = this.readLock();
    if (existing) {
      const alive = await this.opts.checkHealth(existing.port, HEALTH_CHECK_TIMEOUT_MS);
      const sameBuild = this.opts.buildId === undefined || existing.buildId === this.opts.buildId;
      if (alive && sameBuild) {
        const windows = pruneStale(existing.windows, this.opts.now());
        windows[this.opts.windowId] = isoNow(this.opts.now());
        this.writeLock({ ...existing, windows });
        return { port: existing.port };
      }
      if (alive) {
        // **別のビルドのサーバーは止めて起動し直す。** 止めずに新しく起こすと、ロックを上書きした時点で
        // 古い方はどのロックからも参照されない孤児になる。古い方を使っている他のウィンドウは拡張の更新で
        // どのみち再読み込みが要る（そのままでは拡張ホストのコードも古い）
        this.opts.onChildOutput(
          `別のビルドのサーバー（pid ${existing.pid}・${existing.buildId ?? "ビルド不明"}）を止めて起動し直します\n`
        );
        killByPid(existing.pid);
      }
      // 陳腐化（healthzが応答しない）またはビルド違い——自分が新規に起動して上書きする
    }
    const port = await findFreePort(PORT_SEARCH_START);
    const child = this.opts.spawnServer(port);
    // **spawn直後、成否が分かる前に配線する。** 以前は`acquire()`成功後（呼び出し元＝
    // `extension.ts`側）でしか配線しておらず、起動が遅い・失敗する実機（Windows。
    // 初回のアンチウイルススキャン等でnode_modulesへの初回アクセスが遅くなりうる）では、
    // 診断に一番要る「なぜ失敗したか」の出力がパイプの中で誰にも読まれずに失われていた
    this.opts.onChildOutput(`起動中: ${this.opts.serverMainPath} --http ${port} ...\n`);
    child.stdout?.on("data", (buf: Buffer) => this.opts.onChildOutput(buf.toString("utf8")));
    child.stderr?.on("data", (buf: Buffer) => this.opts.onChildOutput(buf.toString("utf8")));
    // **`spawn`自体が失敗したとき（実行ファイルが無い等）はChildProcessが`error`を発火する。**
    // 誰も聞いていないと拡張ホスト全体を巻き込む未処理例外になる（taskcheck T7のmust指摘）。
    // healthz待ちと競走させ、spawn失敗を`acquire()`の失敗として正しく伝播させる
    const spawnError = new Promise<never>((_resolve, reject) => {
      child.once("error", reject);
    });
    let ok: boolean;
    try {
      ok = await Promise.race([waitUntilHealthy(this.opts.checkHealth, port, SPAWN_TIMEOUT_MS), spawnError]);
    } catch (e) {
      // **失敗した自分の子は畳んでから投げる。** 畳まないと、healthzに応答しないまま
      // どのロックにも載らない孤児プロセスとして残り続ける
      killByPid(child.pid ?? -1);
      throw new Error(`サーバーの起動に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!ok) {
      killByPid(child.pid ?? -1);
      throw new Error(`サーバーが起動しませんでした（port ${port}）。「ts5250」出力パネルにエラーが出ていないか確認してください`);
    }

    const lock: LockFile = {
      pid: child.pid ?? -1,
      port,
      startedAt: isoNow(this.opts.now()),
      windows: { [this.opts.windowId]: isoNow(this.opts.now()) },
      ...(this.opts.buildId !== undefined ? { buildId: this.opts.buildId } : {})
    };
    this.writeLock(lock);

    // **書き込み競合の後始末。** 複数ウィンドウが同時に起動を試みたとき「最後に書いた者が勝つ」
    // （design.md「振る舞いの詳細」）——負けた側はここで自分の書き込みが上書きされたことを
    // 検知し、**自分が起動したプロセスを自分で畳んで**勝者のポートへ乗り換える。
    // 畳まないと、どのロックからも参照されない孤児プロセスが残り続ける
    // （design.mdの「ハートビートの陳腐化で自己終了する」という記述は誤りだった——
    // 陳腐化判定は`windows`未登録のエントリを見るものであって、
    // どのロックにも載っていないプロセスはそもそも判定の対象に入らない。
    // taskcheck T7の指摘で発覚・訂正）
    const after = this.readLock();
    if (after && after.pid !== lock.pid) {
      killByPid(lock.pid);
      const windows = pruneStale(after.windows, this.opts.now());
      windows[this.opts.windowId] = isoNow(this.opts.now());
      this.writeLock({ ...after, windows });
      return { port: after.port };
    }

    return { port, child };
  }

  /** このウィンドウの参照を1つ減らす。誰も使っていなくなったらプロセスを止める */
  async release(): Promise<void> {
    const existing = this.readLock();
    if (!existing) return;
    const windows = pruneStale(existing.windows, this.opts.now());
    delete windows[this.opts.windowId];
    if (Object.keys(windows).length === 0) {
      killByPid(existing.pid);
      this.deleteLock();
    } else {
      this.writeLock({ ...existing, windows });
    }
  }

  /**
   * ハートビート（30秒ごとに呼ぶ想定。呼び出しの間隔自体は`extension.ts`が管理する）。
   * **既にacquire済みのウィンドウでなければ何もしない**——release後に誤って
   * 自分のエントリを作り直さないため
   */
  async heartbeat(): Promise<void> {
    const existing = this.readLock();
    if (!existing || !(this.opts.windowId in existing.windows)) return;
    const windows = pruneStale(existing.windows, this.opts.now());
    windows[this.opts.windowId] = isoNow(this.opts.now());
    this.writeLock({ ...existing, windows });
  }

  private readLock(): LockFile | undefined {
    try {
      return JSON.parse(readFileSync(this.opts.lockFilePath, "utf8")) as LockFile;
    } catch {
      return undefined;
    }
  }

  private writeLock(lock: LockFile): void {
    mkdirSync(dirname(this.opts.lockFilePath), { recursive: true });
    writeFileSync(this.opts.lockFilePath, JSON.stringify(lock, null, 2));
  }

  private deleteLock(): void {
    try {
      unlinkSync(this.opts.lockFilePath);
    } catch {
      /* 既に無ければ何もしない */
    }
  }
}

function isoNow(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

/** `STALE_MS`より古いハートビートを除く（新しいオブジェクトを返す。引数を書き換えない） */
function pruneStale(windows: Record<string, string>, nowMs: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, iso] of Object.entries(windows)) {
    if (nowMs - Date.parse(iso) <= STALE_MS) out[id] = iso;
  }
  return out;
}

function killByPid(pid: number): void {
  // **`pid <= 0`は殺さない。** `child.pid`が取れなかったとき（spawn失敗）の既定値`-1`が
  // ここまで来ると、POSIXの`kill(-1, sig)`は「呼び出し元に権限があるすべてのプロセス」への
  // ブロードキャストになる——1台のサーバーを止めるつもりが無関係な多数のプロセスを
  // 巻き込みかねない（taskcheck T7の指摘）
  if (pid <= 0) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 既に落ちていれば何もしない（ESRCH）。pidが再利用され別プロセスに飛ぶ極小の
       リスクは残るが、単一利用者のローカルツールとして許容する（design.md「振る舞いの詳細」
       の調停プロトコルと同じ「厳密な排他は取らない」方針） */
  }
}

/** 空いているTCPポートを探す（`electron/main.cjs`の`findFreePort`と同じアルゴリズム） */
function findFreePort(start: number, attemptsLeft = 20): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => {
      if (attemptsLeft <= 0) reject(new Error(`空きポートが見つかりません（${start} から探索）`));
      else resolve(findFreePort(start + 1, attemptsLeft - 1));
    });
    probe.listen(start, "127.0.0.1", () => {
      const addr = probe.address();
      const port = typeof addr === "object" && addr ? addr.port : start;
      probe.close(() => resolve(port));
    });
  });
}

function defaultSpawnServer(opts: ServiceManagerOptions, port: number): ChildProcess {
  const args = [
    opts.serverMainPath,
    "--http",
    String(port),
    "--web-root",
    opts.webRootPath,
    "--connections",
    opts.connectionsPath,
    "--auto-secret-key",
    "--secret-key-file",
    opts.secretKeyFilePath
  ];
  return spawn(process.execPath, args, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
}

async function defaultCheckHealth(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `/healthz`が200を返すまでポーリングする（`electron/main.cjs`の`waitForHealth`相当） */
async function waitUntilHealthy(
  checkHealth: (port: number, timeoutMs: number) => Promise<boolean>,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (await checkHealth(port, HEALTH_CHECK_TIMEOUT_MS)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(400);
  }
}

/** テスト専用に公開する（プロセスが確実に存在するかの確認等に使う） */
export const __testing = { findFreePort, pruneStale, isoNow, killByPid, existsSync };
