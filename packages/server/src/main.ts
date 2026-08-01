#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log, childLog } from "./log.js";
import { SessionManager } from "./session-manager.js";
import { PersonalConfigStore, ServerConfigStore } from "./config-store.js";
import { MacroStore } from "./macro-store.js";
import { ConfigResolver } from "./config-resolver.js";
import { SecretCrypto } from "./secret-crypto.js";
import { buildMcpServer } from "./mcp-server.js";
import { resolveBindHost } from "./bind-host.js";
import { buildApp } from "./app.js";
import { WatchRegistry } from "./watch-registry.js";
import { startAutoServices } from "./boot-autostart.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "./auth.js";
import { AuditBuffer, installAuditBuffer } from "./audit.js";
import { ResultSetStore } from "./result-set-store.js";
import { DbPool } from "./db-pool.js";
import type { ToolDeps } from "./mcp-tools.js";
import { setLogSink } from "@as400web/base";

/**
 * core（ライブラリ層）のログをサーバーの pino へ流す。
 *
 * core は既定で黙る（利用側にロガーを強制しないため）。**アプリはここで明示的に繋ぐ**。
 * サーバー自身のログは `./log.js` を直接使っており、この注入に依存しない——
 * 呼び忘れで監査証跡が静かに消えることが無いようにしてある。
 */
setLogSink((bindings) => {
  const l = childLog(bindings);
  return {
    debug: (m) => l.debug(m),
    info: (m) => l.info(m),
    warn: (m) => l.warn(m),
    error: (m) => l.error(m),
    isDebugEnabled: () => l.isLevelEnabled("debug")
  };
});

const VERSION = "0.1.0";

interface Args {
  mode: "stdio" | "http";
  port: number;
  /** 待ち受けアドレス（未指定なら認証オフ=127.0.0.1 / 認証オン=0.0.0.0） */
  host: string | undefined;
  profilesPath: string | undefined;
  connectionsPath: string;
  /** マクロ（画面操作の記録）の保存ファイル。秘密は master key で暗号化して入る */
  macrosPath: string;
  webRoot: string | undefined;
  usersPath: string | undefined;
  hashPassword: string | undefined;
  cookieSecure: boolean;
  /** 単一利用者向け: master key が無ければ自動生成して保存する */
  autoSecretKey: boolean;
  /** 自動生成した master key の保存先（既定 .env） */
  secretKeyFile: string;
  /** IFS の zip 一括ダウンロードの上限（未指定なら app.ts の既定） */
  ifsZipMaxBytes: number | undefined;
  ifsZipMaxFiles: number | undefined;
  ifsZipMaxDirectories: number | undefined;
  ifsReadMaxBytes: number | undefined;
  /** IFS の再帰削除の上限（未指定なら host-ifs の既定） */
  ifsDeleteMaxEntries: number | undefined;
  ifsDeleteMaxDirectories: number | undefined;
  /** IFS のフォルダ一括アップロードの上限（未指定なら host-ifs の既定） */
  ifsUploadMaxBytes: number | undefined;
  ifsUploadMaxFiles: number | undefined;
  ifsUploadMaxDirectories: number | undefined;
  /** データ待ち行列の受信待機秒の上限（未指定なら app.ts の既定 60 秒） */
  dtaqReceiveMaxWaitSec: number | undefined;
  /** 同時監視数の上限（データ待ち行列の常駐監視。未指定なら WatchRegistry の既定 4） */
  maxWatches: number | undefined;
  /**
   * セッションのアイドルタイムアウトの**サーバー全体の既定**（ms or `"never"`）。
   * 未指定なら `SessionManager` の既定（＝永続）。共有サーバーで有限に戻すための口。
   */
  idleTimeoutMs: number | "never" | undefined;
}

/**
 * zip64 を実装していないため、アーカイブ全体が 4GB を超えられない。
 *
 * ここで弾くのは**明らかに無理な指定を起動時に知らせる**ため。
 * ヘッダとセントラルディレクトリの分だけアーカイブはデータより大きくなるので、
 * 4GB ちょうどを許すと実行時に溢れる。余裕を見て 1 割弱を引いておく。
 * **最終的な防波堤は `buildZip` 側にある**（そちらが本当の不変条件）。
 */
const ZIP_MAX_BYTES_LIMIT = 0xf000_0000;

/** 上限として妥当な整数か検査して返す */
function parseLimit(raw: string | undefined, name: string, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} は 1〜${max} の整数で指定してください（指定値: ${raw}）`);
  }
  return value;
}

/**
 * `--idle-timeout` の値を内部表現（ms or `"never"`）へ。
 *
 * 単位は**分**。`never` は「切らない」（＝既定と同じだが、明示できるようにしてある）。
 * `0` を「切らない」に使わないのは、未設定・転記漏れと見分けが付かなくなるため（spec 方針2）。
 */
export function parseIdleTimeout(raw: string | undefined): number | "never" {
  if (raw === "never") return "never";
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    throw new Error(`--idle-timeout は 1〜1440 の整数（分）または never で指定してください（指定値: ${raw}）`);
  }
  return minutes * 60_000;
}

/**
 * `--profiles` を渡さなかったときのサーバー設定の置き場。
 * **個人設定（`connections.json`）と同じ形**——既定パスがあり、無ければ空で始まる。
 */
const DEFAULT_PROFILES_PATH = "profiles.json";

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "http",
    port: 3400,
    host: undefined,
    profilesPath: undefined,
    connectionsPath: "connections.json",
    macrosPath: "macros.json",
    webRoot: undefined,
    usersPath: undefined,
    hashPassword: undefined,
    cookieSecure: false,
    autoSecretKey: false,
    secretKeyFile: ".env",
    ifsZipMaxBytes: undefined,
    ifsZipMaxFiles: undefined,
    ifsZipMaxDirectories: undefined,
    ifsReadMaxBytes: undefined,
    ifsDeleteMaxEntries: undefined,
    ifsDeleteMaxDirectories: undefined,
    ifsUploadMaxBytes: undefined,
    ifsUploadMaxFiles: undefined,
    ifsUploadMaxDirectories: undefined,
    dtaqReceiveMaxWaitSec: undefined,
    idleTimeoutMs: undefined,
    maxWatches: undefined
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdio") args.mode = "stdio";
    else if (a === "--host") args.host = argv[++i];
    else if (a === "--http") {
      args.mode = "http";
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args.port = Number(next);
        i++;
      }
    } else if (a === "--profiles") {
      args.profilesPath = argv[++i];
    } else if (a === "--connections") {
      // ユーザー接続設定の保存ファイル（サーバー一元管理）。未指定は connections.json
      args.connectionsPath = argv[++i]!;
    } else if (a === "--macros") {
      // マクロの保存ファイル。未指定は macros.json
      args.macrosPath = argv[++i]!;
    } else if (a === "--ifs-zip-max-bytes") {
      // zip64 非対応なので 4GB 未満に制限する（起動時に弾く）
      args.ifsZipMaxBytes = parseLimit(argv[++i], "--ifs-zip-max-bytes", ZIP_MAX_BYTES_LIMIT);
    } else if (a === "--ifs-zip-max-files") {
      // ZIP の終端レコードの件数は 16 ビット
      args.ifsZipMaxFiles = parseLimit(argv[++i], "--ifs-zip-max-files", 0xffff);
    } else if (a === "--ifs-zip-max-dirs") {
      args.ifsZipMaxDirectories = parseLimit(argv[++i], "--ifs-zip-max-dirs", 1_000_000);
    } else if (a === "--ifs-read-max-bytes") {
      args.ifsReadMaxBytes = parseLimit(argv[++i], "--ifs-read-max-bytes", ZIP_MAX_BYTES_LIMIT);
    } else if (a === "--ifs-delete-max-entries") {
      // 消せる対象（ファイル＋フォルダ）の総数。事故の規模を抑えるための歯止め
      args.ifsDeleteMaxEntries = parseLimit(argv[++i], "--ifs-delete-max-entries", 100_000);
    } else if (a === "--ifs-delete-max-dirs") {
      args.ifsDeleteMaxDirectories = parseLimit(argv[++i], "--ifs-delete-max-dirs", 100_000);
    } else if (a === "--ifs-upload-max-bytes") {
      // 一度に置ける合計。**本文は JSON でメモリに載る**ので zip 取得と同じ桁に留める
      args.ifsUploadMaxBytes = parseLimit(argv[++i], "--ifs-upload-max-bytes", ZIP_MAX_BYTES_LIMIT);
    } else if (a === "--ifs-upload-max-files") {
      args.ifsUploadMaxFiles = parseLimit(argv[++i], "--ifs-upload-max-files", 100_000);
    } else if (a === "--ifs-upload-max-dirs") {
      args.ifsUploadMaxDirectories = parseLimit(argv[++i], "--ifs-upload-max-dirs", 100_000);
    } else if (a === "--dtaq-max-wait") {
      args.dtaqReceiveMaxWaitSec = parseLimit(argv[++i], "--dtaq-max-wait", 3600);
    } else if (a === "--max-watches") {
      // 監視 1 本＝ホストサーバー接続 1 本を占有する（待機中は他の要求を出せない）
      args.maxWatches = parseLimit(argv[++i], "--max-watches", 64);
    } else if (a === "--idle-timeout") {
      // セッション設定を持たない接続にも効く「全体の既定」。既定は永続なので、
      // 有限に戻したい共有サーバーだけが指定する
      args.idleTimeoutMs = parseIdleTimeout(argv[++i]);
    } else if (a === "--web-root") {
      args.webRoot = argv[++i];
    } else if (a === "--users") {
      // ユーザーファイル指定で認証を有効化（per-user 分離）
      args.usersPath = argv[++i];
    } else if (a === "--cookie-secure") {
      args.cookieSecure = true;
    } else if (a === "--trace-records") {
      // 受信レコードを hex でログへ。障害切り分け専用（画面の中身が残るので常用しない）
      process.env.AS400_TRACE_RECORDS = "1";
    } else if (a === "--auto-secret-key") {
      // 単一利用者向け: master key を自動生成して保存（マルチユーザー運用では非推奨）
      args.autoSecretKey = true;
    } else if (a === "--secret-key-file") {
      args.secretKeyFile = argv[++i]!;
    } else if (a === "--hash-password") {
      // ユーティリティ: users.json 用の scrypt ハッシュを出力して終了
      args.hashPassword = argv[++i];
    }
  }
  return args;
}

function buildDeps(args: Args): ToolDeps & { macros: MacroStore } {
  const sessions = new SessionManager(
    args.idleTimeoutMs !== undefined ? { idleTimeoutMs: args.idleTimeoutMs } : {}
  );
  // 既定が永続でも掃除は回す——セッション設定や `--idle-timeout` で有限値が入りうるため
  sessions.startIdleSweep();
  // master key（.env の AS400_SECRET_KEY）。未設定なら自動サインオンのパスワード保存は無効（接続自体は可）。
  // --auto-secret-key（単一利用者向け）なら無ければ生成して保存する。
  let crypto: SecretCrypto | undefined;
  if (args.autoSecretKey) {
    const r = SecretCrypto.fromEnvOrCreate("AS400_SECRET_KEY", args.secretKeyFile);
    crypto = r.crypto;
    if (r.generated) log.info({ file: args.secretKeyFile }, "generated master key for single-user mode");
  } else {
    crypto = SecretCrypto.fromEnv();
    if (!crypto) log.warn("AS400_SECRET_KEY not set: saved auto-signon passwords are disabled");
  }
  // 旧形式のファイルは読み込み時にメモリ上で分解する。**書き戻しは明示的な保存操作のときだけ**
  const migrateWarn = (m: string): void => log.warn(m);
  // **既定パスなら無くても保存できる状態で始める**（`20260801-server-config-bootstrap`）。
  // 明示指定（`--profiles`）は無ければエラー——打ち間違えを黙らせない
  const server = args.profilesPath
    ? ServerConfigStore.fromFile(args.profilesPath, crypto, migrateWarn)
    : ServerConfigStore.fromFileOrEmpty(DEFAULT_PROFILES_PATH, crypto, migrateWarn);
  const personal = PersonalConfigStore.fromFile(args.connectionsPath, crypto, migrateWarn);
  const resolver = new ConfigResolver(server, personal);
  // マクロは接続設定と同じ master key を共有する（秘密の鍵を 2 系統持たない）
  const macros = MacroStore.fromFile(args.macrosPath, crypto);
  return {
    sessions,
    resolver,
    macros,
    version: VERSION,
    // stdio モードは buildApp を通らないので、ここで MCP ツールへ受信待機上限を渡す
    // （CLI 値は parseArgs の parseLimit で 1〜3600 に検証済み）
    ...(args.dtaqReceiveMaxWaitSec !== undefined
      ? { dtaqReceiveMaxWaitSec: args.dtaqReceiveMaxWaitSec }
      : {})
  };
}

/** 認証コンテキストを構築（--users 指定時のみ enabled）。 */
function buildAuth(usersPath: string | undefined, cookieSecure: boolean): AuthContext | undefined {
  if (!usersPath) return undefined;
  return { enabled: true, users: UserStore.fromFile(usersPath), sessions: new SessionStore(), cookieSecure };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  // ユーティリティ: パスワードハッシュを出力して終了（users.json 作成補助）
  if (args.hashPassword !== undefined) {
    process.stdout.write(hashPassword(args.hashPassword) + "\n");
    return;
  }

  const deps = buildDeps(args);
  const auth = buildAuth(args.usersPath, args.cookieSecure);
  // 管理者画面のログ取得用に監査バッファを有効化（認証時のみ意味を持つ）
  // 監査ログは認証の有無に関わらず収集する（個人利用でも管理画面のログを見られるように）
  const auditBuffer = new AuditBuffer();
  installAuditBuffer(auditBuffer);
  if (auth) log.info("authentication enabled (per-user isolation)");
  // 有効なら必ず知らせる。付けたのに出力が無いのか、届いていないのかを迷わせない
  if (process.env.AS400_TRACE_RECORDS === "1") {
    log.warn("受信レコードを hex でログへ出力します（--trace-records・切り分け専用）");
  }

  // 画面のページング用。**このプロセスで唯一「接続を掴み続ける」もの**
  const resultSets = new ResultSetStore();
  // 画面の SQL 用の接続の使い回し（接続の確立に約 4.6 秒かかるため。db-pool.ts に実測）
  const pool = new DbPool();

  if (args.mode === "stdio") {
    // stdio モード: stdout は MCP 専用（ログは stderr のみ = core log）
    const server = buildMcpServer(deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("5250 MCP server started on stdio");
  } else {
    // **main 側で作って渡す。** 起動時の自動開始（`startAutoServices`）が
    // 同じレジストリを触る必要があるため——`buildApp` の中で作られると手が届かない
    const watches = new WatchRegistry(
      args.maxWatches !== undefined ? { maxWatches: args.maxWatches } : {}
    );
    const app = buildApp({
      resultSets,
      pool,
      watches,
      ...deps,
      ...(args.webRoot ? { webRoot: args.webRoot } : {}),
      audit: auditBuffer,
      ...(auth ? { auth } : {}),
      ...(args.ifsZipMaxBytes !== undefined ? { ifsZipMaxBytes: args.ifsZipMaxBytes } : {}),
      ...(args.ifsZipMaxFiles !== undefined ? { ifsZipMaxFiles: args.ifsZipMaxFiles } : {}),
      ...(args.ifsZipMaxDirectories !== undefined
        ? { ifsZipMaxDirectories: args.ifsZipMaxDirectories }
        : {}),
      ...(args.ifsReadMaxBytes !== undefined ? { ifsReadMaxBytes: args.ifsReadMaxBytes } : {}),
      ...(args.maxWatches !== undefined ? { maxWatches: args.maxWatches } : {}),
      ...(args.ifsDeleteMaxEntries !== undefined
        ? { ifsDeleteMaxEntries: args.ifsDeleteMaxEntries }
        : {}),
      ...(args.ifsDeleteMaxDirectories !== undefined
        ? { ifsDeleteMaxDirectories: args.ifsDeleteMaxDirectories }
        : {}),
      ...(args.ifsUploadMaxBytes !== undefined ? { ifsUploadMaxBytes: args.ifsUploadMaxBytes } : {}),
      ...(args.ifsUploadMaxFiles !== undefined ? { ifsUploadMaxFiles: args.ifsUploadMaxFiles } : {}),
      ...(args.ifsUploadMaxDirectories !== undefined
        ? { ifsUploadMaxDirectories: args.ifsUploadMaxDirectories }
        : {}),
      ...(args.dtaqReceiveMaxWaitSec !== undefined
        ? { dtaqReceiveMaxWaitSec: args.dtaqReceiveMaxWaitSec }
        : {})
    });
    // ws の WebSocketServer は WebSocketServerLike と互換（noServer:true 指定済み。optional 差のみ）
    const wss = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    // 認証オフは既定でループバックのみ（信頼境界がネットワーク的に担保されないため）
    const bind = resolveBindHost(args.host, !!auth);
    if (bind.warn) log.warn(bind.warn);
    // **掴んだ接続を残さない**——結果セットは唯一の状態なので、終了時に必ず閉じる
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        resultSets.closeAll();
        pool.closeAll();
        process.exit(0);
      });
    }

    serve({ fetch: app.fetch, port: args.port, hostname: bind.host, websocket: { server: wss } }, (info) => {
      log.info(
        { host: bind.host, port: info.port, auth: !!auth },
        bind.host === "127.0.0.1"
          ? "5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"
          : "5250 MCP/Web server started (Streamable HTTP + WebSocket)"
      );
      // **待ち受けを始めてから立ち上げる。** 繋ぎに行くのに時間がかかるので、
      // HTTP の口を開けるのを待たせない。失敗しても起動は止めない
      // （`20260801-boot-autostart`）
      void startAutoServices({ resolver: deps.resolver, sessions: deps.sessions, watches }).catch((e: unknown) => {
        log.warn(`サービスの自動開始で想定外の失敗: ${e instanceof Error ? e.message : String(e)}`);
      });
    });
  }
}

// このファイルが直接実行されたときのみ起動（テストからの import では起動しない）
// Windows では process.argv[1] がバックスラッシュ区切りのため `file://${argv[1]}` は
// import.meta.url（file:///C:/...）と一致しない。pathToFileURL で正しく URL 化して比較する。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log.error({ err }, "server failed to start");
    process.exit(1);
  });
}
