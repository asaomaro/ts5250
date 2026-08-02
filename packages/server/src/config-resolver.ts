/**
 * 接続設定の**唯一の解決点**。
 *
 * 従来は `ProfileStore` と `ConnectionStore` に解決が分かれ、「connection なら前者 / profile なら後者」
 * という同じ三項分岐が 4 箇所に散っていた。その結果、`warn` の配線漏れ・`enhanced` の欠落・
 * 排他チェックの有無といった挙動の食い違いが生まれていた。ここに集約して構造的に潰す。
 *
 * `warn` を**必須引数**にしているのは意図的（design の判断）。optional にすると渡し忘れが起き、
 * パスワード復号の失敗が無言で握り潰される（実際に 5 経路中 3 経路で起きていた）。
 */
import { As400Error } from "@ts5250/base";
import { type ConnectOptions } from "@ts5250/tn5250";
import type { AuthUser } from "./auth.js";
import type { PcCommandConfig } from "./pc-command.js";
import type { PrinterOutputConfig } from "./printer-output.js";
import { autoStartOf } from "./service-state.js";
import { webhookSecret } from "./webhook-sink.js";
import {
  idleTimeoutToMs,
  parseRef,
  sessionPrinter,
  sessionWebhook,
  type AnySession,
  type ConfigSource,
  type PublicSession,
  type WebhookConfig,
  type ServiceDef,
  type PublicSystem,
  type System
} from "./config-types.js";
import type { ConfigStore, PersonalConfigStore, ServerConfigStore } from "./config-store.js";

export interface TargetRef {
  /** システム参照（`srv:<name>` / `own:<id>`） */
  system?: string | undefined;
  /** セッション設定参照。指定すると親システムまで一意に決まる */
  session?: string | undefined;
}

export interface ResolvedTarget {
  /** deviceNameRetry はサーバー側（SessionManager）で解釈するので ConnectOptions に足して運ぶ */
  connect: ConnectOptions & {
    deviceNameRetry?: boolean;
    rescueAction?: "hold" | "delete";
    transformTo?: string;
    /** アイドルタイムアウト（**ms** or `"never"`）。設定の「分」はここで変換済み */
    idleTimeoutMs?: number | "never";
  };
  /** **サーバー設定由来のセッションのときのみ**（信頼設定） */
  printerOutput?: PrinterOutputConfig;
  /**
   * **サービスとして常駐する**（WS が切れても待ち受けを止めない）。
   * 出力設定と同じ 5 層目——サーバー設定由来のときだけ true になりうる
   */
  service?: boolean;
  /**
   * 開いた直後に待ち受けを開始するか（**未設定は true**）。
   * 信頼設定ではないので、個人設定でも持てる
   */
  autoStart: boolean;
  /**
   * PC コマンド（STRPCCMD）の実行設定。**サーバー設定由来のセッションのときのみ**（信頼設定）。
   * 個人設定はスキーマに持たないので、ここに来ることはそもそも無い（1 層目）
   */
  pcCommand?: PcCommandConfig;
  /**
   * 待ち行列サービスの転送先。**サーバー設定由来のときのみ**（同じ 5 層目）。
   * `secret` は**復号済み**——ここが唯一の解く場所（`resolvePassword` と同じ扱い）
   */
  webhook?: { config: WebhookConfig; secret?: string };
  source: ConfigSource;
  system: System;
  session?: AnySession;
}

export type Warn = (msg: string) => void;

export class ConfigResolver {
  constructor(
    private readonly server: ServerConfigStore | undefined,
    private readonly personal: PersonalConfigStore | undefined
  ) {}

  private storeFor(source: ConfigSource): ConfigStore {
    const store = source === "server" ? this.server : this.personal;
    if (!store) {
      throw new As400Error(
        "CONFIG_ERROR",
        source === "server" ? "server settings not configured" : "connection store not configured"
      );
    }
    return store;
  }

  /**
   * 参照を接続オプションに解決する。
   *
   * - `session` のみ … 基本形。親システムから資格情報を得る
   * - `system` のみ … 装置名なしで接続（`deviceName` は core で optional。ホスト採番になる）
   * - 両方 … **食い違いはエラー**。従来の「黙って片方が勝つ」は混線の再生産なので採らない
   */
  resolve(ref: TargetRef, user: AuthUser | undefined, warn: Warn): ResolvedTarget {
    if (!ref.system && !ref.session) {
      throw new As400Error("CONFIG_ERROR", "system, session, or host required");
    }

    let session: AnySession | undefined;
    let source: ConfigSource;
    let store: ConfigStore;
    let systemId: string;

    if (ref.session) {
      const parsed = requireRef(ref.session, "session");
      source = parsed.source;
      store = this.storeFor(source);
      session = store.getSession(parsed.id);
      store.assertAccess(ownerOf(session), user);
      systemId = session.system;

      if (ref.system) {
        const sysRef = requireRef(ref.system, "system");
        if (sysRef.source !== source || sysRef.id !== systemId) {
          throw new As400Error(
            "CONFIG_ERROR",
            `session ${ref.session} does not belong to system ${ref.system}`
          );
        }
      }
    } else {
      const parsed = requireRef(ref.system!, "system");
      source = parsed.source;
      store = this.storeFor(source);
      systemId = parsed.id;
    }

    const system = store.getSystem(systemId);
    store.assertAccess(system.owner, user);

    const connect = this.buildConnect(system, session, store, warn);
    // 開いた直後に待ち受けを開始するか。**未設定は true**（いまある定義の挙動を変えない）
    const out: ResolvedTarget = { connect, source, system, autoStart: autoStartOf(session?.autoStart) };
    if (session) out.session = session;
    // printer 出力はサーバー設定由来のセッションからのみ供給する（信頼境界の 5 層目）
    const printerOutput = source === "server" && session ? toPrinterOutput(session) : undefined;
    if (printerOutput) out.printerOutput = printerOutput;
    // **サービスとして常駐するか。** 出力設定の有無から導出しない——
    // 導出すると「開いている間だけ PDF に落とす」も「常駐して溜めるだけ」も表現できない
    // （`20260801-service-lifecycle-model` design D3）。
    // 出力設定と同じ 5 層目（サーバー設定由来のときだけ受理する）
    const service = source === "server" && session ? sessionPrinter(session)?.service === true : false;
    if (service) out.service = true;
    // PC コマンドも同じ 5 層目。display セッションでしか意味を持たない
    const pcCommand =
      source === "server" && session?.sessionType === "display" ? sessionPcCommand(session) : undefined;
    if (pcCommand) out.pcCommand = pcCommand;
    // 転送先も同じ 5 層目。**サーバー設定由来のときだけ受理する**
    const wh = source === "server" && session ? sessionWebhook(session) : undefined;
    if (wh) {
      const crypto = store.secretCrypto;
      const secret = webhookSecret(
        wh,
        (enc) => {
          if (!crypto) throw new Error("secret key not configured");
          return crypto.decrypt(enc);
        },
        warn
      );
      out.webhook = { config: wh, ...(secret !== undefined ? { secret } : {}) };
    }
    return out;
  }

  private buildConnect(
    system: System,
    session: AnySession | undefined,
    store: ConfigStore,
    warn: Warn
  ): ConnectOptions {
    const opts: ConnectOptions & {
      deviceNameRetry?: boolean;
      rescueAction?: "hold" | "delete";
      transformTo?: string;
      idleTimeoutMs?: number | "never";
    } = { host: system.host };
    if (system.port !== undefined) opts.port = system.port;
    // 転記漏れがあると平文で繋がる。ポート省略時の既定は tls で 992／平文で 23 のため、
    // tls:true だけ設定したシステムは「23 番へ平文で接続して成功する」＝気づけない形になる
    if (system.tls !== undefined) opts.tls = system.tls;

    // CCSID はセッション側の上書きを優先する
    const ccsid = session?.ccsid ?? system.ccsid;
    if (ccsid !== undefined) opts.ccsid = ccsid;
    // スプール用 CCSID は**システムだけが持つ**（pull 型はセッションに紐づかない。spec 方針2）。
    // 上の ccsid へフォールバックしない——5250 画面用とは別の設定である
    if (system.spoolCcsid !== undefined) opts.spoolCcsid = system.spoolCcsid;

    if (session) {
      if (session.deviceName !== undefined) opts.deviceName = session.deviceName;
      if (session.deviceNameRetry !== undefined) opts.deviceNameRetry = session.deviceNameRetry;
      // 分 → ms の変換はここ 1 か所だけで行う（入口ごとに書くと片方が分のまま流れる）
      const idle = idleTimeoutToMs(session.idleTimeout);
      if (idle !== undefined) opts.idleTimeoutMs = idle;
      if (session.sessionType === "printer") {
        if (session.rescueAction !== undefined) opts.rescueAction = session.rescueAction;
        if (session.transformTo !== undefined) opts.transformTo = session.transformTo;
      }
      // 画面サイズ・拡張は display のみ意味を持つ
      if (session.sessionType === "display") {
        if (session.screenSize !== undefined) opts.screenSize = session.screenSize;
        if (session.enhanced !== undefined) opts.enhanced = session.enhanced;
      }
    }

    const cred = this.resolvePassword(system, store, warn);
    if (cred) {
      opts.user = cred.user;
      opts.password = cred.password;
    }
    return opts;
  }

  /**
   * 資格情報を解決する。復号失敗は**エラーにせず** `warn` して自動サインオンなしで続行する
   * （鍵ローテーション時に全接続が落ちるのを避けるため）。`passwordEnv` の設定漏れだけは明示エラー。
   */
  private resolvePassword(
    system: System,
    store: ConfigStore,
    warn: Warn
  ): { user: string; password: string } | undefined {
    const s = system.signon;
    if (!s) return undefined;
    let password: string | undefined;

    if (s.passwordEnc !== undefined) {
      const crypto = store.secretCrypto;
      if (crypto) {
        try {
          password = crypto.decrypt(s.passwordEnc);
        } catch {
          warn(`system ${system.name}: failed to decrypt saved password (auto-signon skipped)`);
        }
      } else {
        warn(`system ${system.name}: secret key not configured (auto-signon skipped)`);
      }
    } else if (s.passwordEnv !== undefined) {
      password = process.env[s.passwordEnv];
      if (password === undefined || password === "") {
        throw new As400Error(
          "CONFIG_ERROR",
          `system ${system.name}: password not available (env ${s.passwordEnv} unset)`
        );
      }
    }

    // user だけあって password 機構が無い場合は自動サインオンせず、サインオン画面に着地する
    if (password === undefined || password === "") return undefined;
    return { user: s.user, password };
  }

  /**
   * 全保管場所を横断したシステム一覧（見える範囲のみ）。
   *
   * @param opts.serverSignon サーバー設定のユーザー名をプレフィル用に含めるか（編集者のみ true にする）。
   *   個人設定は所有者にしか見えないため常に含める（旧 `PublicConnection` と同じ扱い）。
   *   **既定は false**——MCP など機械向けの一覧に内部の値を渡さないため。
   */
  listSystems(user: AuthUser | undefined, opts?: { serverSignon?: boolean }): PublicSystem[] {
    return [
      ...(this.server?.listSystems(user, { includeSignon: opts?.serverSignon === true }) ?? []),
      ...(this.personal?.listSystems(user, { includeSignon: true }) ?? [])
    ];
  }

  /** 全保管場所を横断したセッション設定一覧（見える範囲のみ） */
  listSessions(user: AuthUser | undefined, opts?: { includeTrusted?: boolean }): PublicSession[] {
    return [
      ...(this.server?.listSessions(user, opts) ?? []),
      ...(this.personal?.listSessions(user, opts) ?? [])
    ];
  }

  /**
   * サービス定義の**名札だけ**（`20260801-services-pane`）。
   *
   * **サーバー設定のぶんは admin でなくても返る。** `listSessions` の認可規則は
   * 緩めていない——返す形（`ServiceDef`）にホストもパスも装置名も入っていないため、
   * 「いま何が動いているか」だけが見える。
   */
  listServiceDefs(user: AuthUser | undefined): ServiceDef[] {
    return [...(this.server?.listServiceDefs(user) ?? []), ...(this.personal?.listServiceDefs(user) ?? [])];
  }

  storeOf(source: ConfigSource): ConfigStore {
    return this.storeFor(source);
  }
}

function requireRef(ref: string, what: string): { source: ConfigSource; id: string } {
  const parsed = parseRef(ref);
  if (!parsed) {
    throw new As400Error(
      "CONFIG_ERROR",
      `invalid ${what} reference "${ref}" (expected srv:<name> or own:<id>)`
    );
  }
  return parsed;
}

/** セッションの pcCommand 設定を実行時設定へ写す。サーバー設定のセッションだけが持てる */
function sessionPcCommand(session: AnySession): PcCommandConfig | undefined {
  const pc = "pcCommand" in session ? session.pcCommand : undefined;
  if (!pc) return undefined;
  const cfg: PcCommandConfig = {};
  if (pc.enabled !== undefined) cfg.enabled = pc.enabled;
  if (pc.timeoutMs !== undefined) cfg.timeoutMs = pc.timeoutMs;
  if (pc.cwd !== undefined) cfg.cwd = pc.cwd;
  if (pc.allow !== undefined) cfg.allow = [...pc.allow];
  return cfg;
}

function ownerOf(s: AnySession): string | undefined {
  return "owner" in s ? s.owner : undefined;
}

/** セッションの printer 設定を実行時の出力設定へ写す。両方空なら undefined */
function toPrinterOutput(session: AnySession): PrinterOutputConfig | undefined {
  const pr = sessionPrinter(session);
  if (!pr || (!pr.autoPdfDir && !pr.autoPrint)) return undefined;
  const cfg: PrinterOutputConfig = {};
  if (pr.autoPdfDir !== undefined) cfg.autoPdfDir = pr.autoPdfDir;
  if (pr.autoPrint !== undefined) cfg.autoPrint = pr.autoPrint;
  const pdf: NonNullable<PrinterOutputConfig["pdf"]> = {};
  if (pr.pdfFontPath !== undefined) pdf.fontPath = pr.pdfFontPath;
  if (pr.pdfFontName !== undefined) pdf.fontName = pr.pdfFontName;
  if (pr.pageSize !== undefined) pdf.pageSize = pr.pageSize;
  if (pr.fontSize !== undefined) pdf.fontSize = pr.fontSize;
  if (Object.keys(pdf).length > 0) cfg.pdf = pdf;
  return cfg;
}
