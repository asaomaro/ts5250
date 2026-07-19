#!/usr/bin/env node
import { serve, type WebSocketServerLike } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { log } from "@as400web/core";
import { SessionManager } from "./session-manager.js";
import { PersonalConfigStore, ServerConfigStore } from "./config-store.js";
import { ConfigResolver } from "./config-resolver.js";
import { SecretCrypto } from "./secret-crypto.js";
import { buildMcpServer } from "./mcp-server.js";
import { resolveBindHost } from "./bind-host.js";
import { buildApp } from "./app.js";
import { UserStore, SessionStore, hashPassword, type AuthContext } from "./auth.js";
import { AuditBuffer, installAuditBuffer } from "./audit.js";
import type { ToolDeps } from "./mcp-tools.js";

const VERSION = "0.1.0";

interface Args {
  mode: "stdio" | "http";
  port: number;
  /** 待ち受けアドレス（未指定なら認証オフ=127.0.0.1 / 認証オン=0.0.0.0） */
  host: string | undefined;
  profilesPath: string | undefined;
  connectionsPath: string;
  webRoot: string | undefined;
  usersPath: string | undefined;
  hashPassword: string | undefined;
  cookieSecure: boolean;
  /** 単一利用者向け: master key が無ければ自動生成して保存する */
  autoSecretKey: boolean;
  /** 自動生成した master key の保存先（既定 .env） */
  secretKeyFile: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "http",
    port: 3400,
    host: undefined,
    profilesPath: undefined,
    connectionsPath: "connections.json",
    webRoot: undefined,
    usersPath: undefined,
    hashPassword: undefined,
    cookieSecure: false,
    autoSecretKey: false,
    secretKeyFile: ".env"
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

function buildDeps(args: Args): ToolDeps {
  const sessions = new SessionManager();
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
  const server = args.profilesPath
    ? ServerConfigStore.fromFile(args.profilesPath, crypto, migrateWarn)
    : new ServerConfigStore({ systems: [], sessions: [] }, crypto);
  const personal = PersonalConfigStore.fromFile(args.connectionsPath, crypto, migrateWarn);
  const resolver = new ConfigResolver(server, personal);
  return { sessions, resolver, version: VERSION };
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

  if (args.mode === "stdio") {
    // stdio モード: stdout は MCP 専用（ログは stderr のみ = core log）
    const server = buildMcpServer(deps);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("5250 MCP server started on stdio");
  } else {
    const app = buildApp({
      ...deps,
      ...(args.webRoot ? { webRoot: args.webRoot } : {}),
      audit: auditBuffer,
      ...(auth ? { auth } : {})
    });
    // ws の WebSocketServer は WebSocketServerLike と互換（noServer:true 指定済み。optional 差のみ）
    const wss = new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike;
    // 認証オフは既定でループバックのみ（信頼境界がネットワーク的に担保されないため）
    const bind = resolveBindHost(args.host, !!auth);
    if (bind.warn) log.warn(bind.warn);
    serve({ fetch: app.fetch, port: args.port, hostname: bind.host, websocket: { server: wss } }, (info) => {
      log.info(
        { host: bind.host, port: info.port, auth: !!auth },
        bind.host === "127.0.0.1"
          ? "5250 MCP/Web server started (localhost only. 公開するには --users と --host を指定)"
          : "5250 MCP/Web server started (Streamable HTTP + WebSocket)"
      );
    });
  }
}

// このファイルが直接実行されたときのみ起動（テストからの import では起動しない）
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error({ err }, "server failed to start");
    process.exit(1);
  });
}
