import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CommandError,
  SqlError,
  As400Error,
  type ConnectOptions,
  type ScreenSnapshot,
  type SendAidResult,
  type SendAidOptions,
  type AidKey
} from "@as400web/core";
import { childLog } from "./log.js";
import { orphanSafeIdleTimeoutMs, SessionManager, type OpenOptions } from "./session-manager.js";
import type { ConfigResolver } from "./config-resolver.js";
import type { PublicSession, PublicSystem } from "./config-types.js";
import type { AuthUser } from "./auth.js";
import { screenToText, screenToAnsi, attributeRuns, type FormatOptions, type ScreenSection } from "./format.js";
import { renderSpoolPdf } from "./pdf.js";
import type { PrinterOutputConfig } from "./printer-output.js";
import { fieldSignon } from "./signon.js";
import { renderScreenHtml, renderScreenHistoryHtml, renderSpoolHtml } from "@as400web/core";
import { ScreenRecorder } from "./screen-recorder.js";
import { withAudit } from "./audit.js";

const mcpLog = childLog({ component: "mcp-tools" });

export interface ToolDeps {
  sessions: SessionManager;
  /** 接続設定の唯一の解決点（system / session 参照 → 接続オプション） */
  resolver: ConfigResolver;
  version: string;
  /** 認証時の呼び出しユーザー（per-user 分離）。未認証/OFF は undefined */
  user?: AuthUser;
  /**
   * データ待ち行列の受信待機秒の上限（未指定なら既定 60 秒）。
   * **HTTP ルートと同じ歯止めを MCP にも効かせるため**——ここが無いと `--dtaq-max-wait` で
   * 締めた上限が /mcp 経路だけ効かず、MCP から既定 60 秒まで待ててしまう。
   */
  dtaqReceiveMaxWaitSec?: number;
}

const AID_KEYS = [
  "Enter", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
  "PageUp", "PageDown", "Clear", "Help", "Print", "SysReq", "Attn"
] as const;

// ---- 共通スキーマ ----
const includeSchema = z
  .array(z.enum(["grid", "fields", "attributes", "ansi"]))
  .optional()
  .describe(
    "含めるもの（既定 grid,fields）。attributes=表示属性の変わり目、" +
      "ansi=色つき画面（人が端末で見る用。LLM 向けの本文には載せない）"
  );
const rowsSchema = z.object({ from: z.number().int(), to: z.number().int() }).optional();
const cursorSchema = z.object({ row: z.number().int(), col: z.number().int() });
const fieldInputSchema = z.object({
  field: z.union([z.number().int(), cursorSchema]),
  value: z.string()
});

const attrRunSchema = z.object({
  row: z.number(),
  col: z.number(),
  len: z.number(),
  color: z.string(),
  reverse: z.boolean().optional(),
  underline: z.boolean().optional(),
  blink: z.boolean().optional(),
  columnSeparator: z.boolean().optional(),
  nonDisplay: z.boolean().optional()
});

const fieldOutSchema = z.object({
  index: z.number(),
  row: z.number(),
  col: z.number(),
  length: z.number(),
  protected: z.boolean(),
  hidden: z.boolean(),
  numeric: z.boolean(),
  mdt: z.boolean(),
  value: z.string()
});

/** 拡張 5250 GUI 構造体の structuredContent スキーマ */
const guiChoiceSchema = z.object({
  index: z.number(),
  text: z.string(),
  selected: z.boolean(),
  available: z.boolean(),
  numericChar: z.number().optional(),
  aid: z.number().optional()
});
const guiSchema = z.object({
  selectionFields: z.array(
    z.object({
      id: z.number(),
      row: z.number(),
      col: z.number(),
      kind: z.enum(["radio", "checkbox", "pushbutton", "menu"]),
      fieldType: z.number(),
      multiple: z.boolean(),
      choices: z.array(guiChoiceSchema)
    })
  ),
  windows: z.array(
    z.object({
      id: z.number(),
      row: z.number(),
      col: z.number(),
      width: z.number(),
      height: z.number(),
      // WDWTITLE は文字だけでなく寄せ方・脚注か・色を持つ（枠の辺に描くために要る）
      title: z
        .object({
          text: z.string(),
          align: z.enum(["center", "left", "right"]),
          footer: z.boolean(),
          cba: z.number()
        })
        .optional(),
      restrictCursor: z.boolean(),
      pulldown: z.boolean()
    })
  ),
  scrollBars: z.array(
    z.object({
      id: z.number(),
      row: z.number(),
      col: z.number(),
      horizontal: z.boolean(),
      total: z.number(),
      sliderPos: z.number(),
      size: z.number()
    })
  )
});

/** 画面を返すツールの structuredContent スキーマ。
 *  text（固定形式の画面イメージ）は content[].text と同内容を持たせる: outputSchema を持つツールでは
 *  クライアントが structuredContent のみを採用し content[].text を捨てることがあり、それだと画面が
 *  LLM に届かないため。 */
const screenOutShape = {
  /** 固定形式の画面テキスト（grid＋fields。content[].text と同内容） */
  text: z.string(),
  sessionId: z.string(),
  rows: z.number(),
  cols: z.number(),
  cursor: cursorSchema,
  keyboardLocked: z.boolean(),
  timedOut: z.boolean().optional(),
  fields: z.array(fieldOutSchema),
  systemMessage: z.string().optional(),
  gui: guiSchema.optional(),
  /** 表示属性の変わり目（include に attributes を入れたときだけ） */
  attributes: z.array(attrRunSchema).optional()
};

type FieldInput = z.infer<typeof fieldInputSchema>;

function fieldTarget(f: FieldInput["field"]): { index: number } | { row: number; col: number } {
  return typeof f === "number" ? { index: f } : { row: f.row, col: f.col };
}

/**
 * 画面応答を組み立てる。画面テキストは content[].text と structuredContent.text の両方に載せる。
 *
 * **色つき画面（ansi）は人向けの別ブロックにする。** エスケープ列を LLM 向けの本文に混ぜると
 * 読みにくいうえトークンを食うだけなので、`audience: ["user"]` を付けて分ける
 * （本文側は `["assistant"]`）。属性を機械可読で欲しい場合は `attributes` を使う。
 */
function screenResult(snap: ScreenSnapshot, fmt: FormatOptions, timedOut?: boolean) {
  const want = new Set(fmt.include ?? []);
  // ansi は表示形式であってセクションではない。テキスト側の include からは外す
  const textFmt: FormatOptions = { ...fmt, ...(fmt.include ? { include: fmt.include.filter((s) => s !== "ansi") } : {}) };
  const text = screenToText(snap, textFmt);
  const structured: Record<string, unknown> = {
    text,
    sessionId: snap.sessionId,
    rows: snap.rows,
    cols: snap.cols,
    cursor: snap.cursor,
    keyboardLocked: snap.keyboardLocked,
    fields: snap.fields
  };
  if (snap.systemMessage !== undefined) structured["systemMessage"] = snap.systemMessage;
  if (snap.gui !== undefined) structured["gui"] = snap.gui;
  if (timedOut !== undefined) structured["timedOut"] = timedOut;
  if (want.has("attributes")) structured["attributes"] = attributeRuns(snap, fmt);
  type Block = { type: "text"; text: string; annotations: { audience: ("user" | "assistant")[] } };
  const content: Block[] = [{ type: "text", text, annotations: { audience: ["assistant"] } }];
  if (want.has("ansi")) {
    content.unshift({
      type: "text",
      text: screenToAnsi(snap, fmt),
      annotations: { audience: ["user"] }
    });
  }
  return { content, structuredContent: structured };
}

function fmtOpts(input: {
  include?: ScreenSection[] | undefined;
  rows?: { from: number; to: number } | undefined;
}): FormatOptions {
  const o: FormatOptions = {};
  if (input.include) o.include = input.include;
  if (input.rows) o.rows = input.rows;
  return o;
}

/**
 * エラーを MCP の isError レスポンスに変換する。
 *
 * `SqlError` / `CommandError` は **診断に効く追加情報を型として持っている**ため、
 * code/message に潰さず error に載せる（SQLCODE を見ないと文法誤りと権限不足が区別できない）。
 * 5250 系ツールの既存の応答形は変えていない（フィールドの追加のみ）。
 */
export function errorResult(err: unknown) {
  const code = err instanceof As400Error ? err.code : "INTERNAL_ERROR";
  const message = err instanceof Error ? err.message : String(err);
  const detail: Record<string, unknown> = {};
  if (err instanceof SqlError) {
    detail["sqlCode"] = err.sqlCode;
    detail["sqlState"] = err.sqlState;
  }
  if (err instanceof CommandError && err.primary) {
    detail["messageId"] = err.primary.id;
    detail["messageText"] = err.primary.text;
  }
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, ...detail } }
  };
}

/**
 * 10 個の MCP ツールを McpServer に登録する（spec「MCP ツール」）。
 * 全ツール zod 入力スキーマ＋outputSchema、画面を返すものは text+structuredContent。
 * 認証情報はツール引数に取らない（D13）。サインオンは profile 経由（自動）か signon ツール（画面フィールド）。
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { sessions, resolver, user } = deps;
  const warn = (m: string): void => mcpLog.warn(m);

  /** system / session 参照を解決する。認可・復号・printer 出力の判定は ConfigResolver 内 */
  const resolveTarget = (input: { system?: string | undefined; session?: string | undefined }) =>
    resolver.resolve({ system: input.system, session: input.session }, user, warn);

  const hasRef = (i: { system?: string | undefined; session?: string | undefined }): boolean =>
    Boolean(i.system ?? i.session);
  const originOf = (i: { system?: string | undefined; session?: string | undefined }): string =>
    i.session ?? i.system ?? "direct";

  server.registerTool(
    "open_session",
    {
      description:
        "5250 セッションを開く。session 指定で保存済みのセッション設定（装置名・画面サイズを含む）、" +
        "system 指定で接続先だけを選ぶ（装置名はホスト採番）、または host 等を直接指定。" +
        "readOnly で閲覧専用。認証情報は引数に取らない。" +
        "host 直接指定は既定で平文 telnet(23) になるため、TLS で繋ぐ場合は tls:true（ポート省略時 992）を指定する。",
      inputSchema: {
        system: z.string().optional(),
        session: z.string().optional(),
        host: z.string().optional(),
        port: z.number().int().optional(),
        ccsid: z.number().int().optional(),
        screenSize: z.enum(["24x80", "27x132"]).optional(),
        deviceName: z.string().optional(),
        enhanced: z.boolean().optional(),
        tls: z.boolean().optional(),
        readOnly: z.boolean().optional()
      },
      outputSchema: screenOutShape
    },
    async (input) =>
      withAudit({ op: "open_session" }, async () => {
        try {
          const opts: OpenOptions = hasRef(input)
            ? { ...resolveTarget(input).connect, origin: originOf(input) }
            : buildDirectOpts(input);
          const entry = await sessions.open({
            ...opts,
            readOnly: input.readOnly ?? false,
            // **MCP には切断の通知が無い**（ツール呼び出しごとの HTTP）。永続を通すと
            // 落ちたクライアントのセッションを閉じる者が居なくなるので、有限値に落とす（research F2）
            idleTimeoutMs: mcpIdleTimeout(opts.idleTimeoutMs)
          });
          return screenResult(entry.session.snapshot(), {});
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "signon",
    {
      description:
        "接続済みセッションの現在画面に、システムの資格情報を画面フィールド入力してサインオン（フォールバック）。" +
        "PUB400 等は auto-signon 済みの open_session を推奨。",
      inputSchema: { sessionId: z.string(), system: z.string() },
      outputSchema: screenOutShape
    },
    async ({ sessionId, system }) =>
      withAudit({ op: "signon", sessionId }, async () => {
        try {
          const entry = sessions.assertWritable(sessionId, user);
          const opts = resolver.resolve({ system }, user, warn).connect;
          if (!opts.user || !opts.password) {
            throw new As400Error("CONFIG_ERROR", `system ${system} has no signon credentials`);
          }
          const r = await fieldSignon(entry.session, opts.user, opts.password);
          return screenResult(r.screen, {}, r.timedOut);
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "close_session",
    {
      description: "セッションを切断する。",
      inputSchema: { sessionId: z.string() },
      outputSchema: { closed: z.boolean() }
    },
    async ({ sessionId }) =>
      withAudit({ op: "close_session", sessionId }, async () => {
        try {
          await sessions.close(sessionId, user);
          return { content: [{ type: "text" as const, text: "closed" }], structuredContent: { closed: true } };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "list_sessions",
    {
      description: "開いているセッションの一覧。",
      inputSchema: {},
      outputSchema: {
        sessions: z.array(
          z.object({
            sessionId: z.string(),
            host: z.string(),
            origin: z.string(),
            connectedAt: z.string(),
            readOnly: z.boolean(),
            keyboardLocked: z.boolean()
          })
        )
      }
    },
    async () =>
      withAudit({ op: "list_sessions" }, async () => {
        const list = sessions.list(user).map((e) => ({
          sessionId: e.id,
          host: e.host,
          origin: e.origin,
          connectedAt: e.connectedAt,
          readOnly: e.readOnly,
          keyboardLocked: e.session.keyboardLocked
        }));
        return {
          content: [{ type: "text" as const, text: `${list.length} session(s)` }],
          structuredContent: { sessions: list }
        };
      })
  );

  server.registerTool(
    "list_systems",
    {
      description:
        "接続できるシステムの一覧（接続先と資格情報のまとまり）。ref を open_session の system 引数に渡す。" +
        "SQL・IFS・一覧など装置名を必要としない操作は、これだけを指定すれば足りる。" +
        "可視範囲は認証状態に従う: 認証オフは全件、admin は全件、一般ユーザーは自分の設定のみ" +
        "（サーバー設定は admin 専用）。**資格情報は返さない**（設定の有無だけ）。",
      inputSchema: {},
      outputSchema: {
        systems: z.array(
          z.object({
            /** open_session の system に渡す値（`srv:<name>` / `own:<id>`） */
            ref: z.string(),
            name: z.string(),
            host: z.string(),
            port: z.number().optional(),
            tls: z.boolean().optional(),
            /** 自動サインオンが設定されているか（ユーザー名・パスワードは返さない） */
            autoSignon: z.boolean()
          })
        )
      }
    },
    async () =>
      withAudit({ op: "list_systems" }, async () => {
        // 露出は「接続先を選ぶのに必要な最小限」に絞る。signon の user 名は返さない
        // ——LLM のコンテキストに残るため、サーバー内部の値を渡さない
        const systems = resolver.listSystems(user).map((s: PublicSystem) => ({
          ref: s.ref,
          name: s.name,
          host: s.host,
          ...(s.port !== undefined ? { port: s.port } : {}),
          ...(s.tls !== undefined ? { tls: s.tls } : {}),
          autoSignon: s.autoSignon
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: systems.length
                ? systems.map((e: { ref: string; name: string; host: string }) => `${e.ref} — ${e.name} (${e.host})`).join("\n")
                : "利用できるシステムがありません"
            }
          ],
          structuredContent: { systems }
        };
      })
  );

  server.registerTool(
    "list_session_configs",
    {
      description:
        "保存済みのセッション設定の一覧（装置名・画面サイズを持つ）。ref を open_session の session 引数に渡す。" +
        "session を指定すると親システムまで一意に決まるので、system の指定は要らない。" +
        "**信頼設定（PDF 自動蓄積・自動印刷）は返さない**。" +
        "なお list_sessions は「いま開いているセッション」の一覧で、別物。",
      inputSchema: {},
      outputSchema: {
        sessions: z.array(
          z.object({
            /** open_session の session に渡す値 */
            ref: z.string(),
            name: z.string(),
            /** 親システムの ref */
            system: z.string(),
            sessionType: z.enum(["display", "printer"]),
            deviceName: z.string().optional(),
            screenSize: z.enum(["24x80", "27x132"]).optional()
          })
        )
      }
    },
    async () =>
      withAudit({ op: "list_session_configs" }, async () => {
        const list = resolver.listSessions(user).map((s: PublicSession) => ({
          ref: s.ref,
          name: s.name,
          system: s.system,
          sessionType: s.sessionType,
          ...(s.deviceName !== undefined ? { deviceName: s.deviceName } : {}),
          ...(s.screenSize !== undefined ? { screenSize: s.screenSize } : {})
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: list.length
                ? list
                    .map(
                      (e: { ref: string; name: string; sessionType: string; system: string }) =>
                        `${e.ref} — ${e.name} (${e.sessionType}, system ${e.system})`
                    )
                    .join("\n")
                : "保存済みのセッション設定がありません"
            }
          ],
          structuredContent: { sessions: list }
        };
      })
  );

  // ---- プリンターセッション（TN5250E: スプールを SCS 受信 → 等幅テキスト） ----
  server.registerTool(
    "open_printer_session",
    {
      description:
        "TN5250E プリンターセッションを開いて待ち受ける。ホストのスプール出力（帳票・ジョブログ等）を" +
        "受信でき、wait_spool で内容を等幅テキストとして取得する。deviceName 省略時はホスト採番。" +
        "認証情報は引数に取らない（D13）。デバイス作成に認証が要るホストでは system または session を指定する。" +
        "host 直接指定は既定で平文 telnet(23) になるため、TLS で繋ぐ場合は tls:true（ポート省略時 992）を指定する。",
      inputSchema: {
        system: z.string().optional(),
        session: z.string().optional(),
        host: z.string().optional(),
        port: z.number().int().optional(),
        deviceName: z.string().optional(),
        ccsid: z.number().int().optional(),
        tls: z.boolean().optional()
      },
      outputSchema: { sessionId: z.string(), startupCode: z.string() }
    },
    async (input) =>
      withAudit({ op: "open_printer_session" }, async () => {
        try {
          // 資格情報は system / session 経由のみ（D13）。host 直接指定では認証情報を持たない
          const target = hasRef(input) ? resolveTarget(input) : undefined;
          const src: ConnectOptions = target
            ? target.connect
            : {
                host: input.host ?? "",
                ...(input.port !== undefined ? { port: input.port } : {}),
                ...(input.ccsid !== undefined ? { ccsid: input.ccsid } : {}),
                ...(input.tls !== undefined ? { tls: input.tls } : {})
              };
          const entry = await sessions.openPrinter({
            ...(src.host ? { host: src.host } : {}),
            ...(src.port !== undefined ? { port: src.port } : {}),
            // 引数指定を優先しつつ、無ければ**セッション設定の装置名を使う**。
            // 以前は input.deviceName を無条件に渡しており、MCP 経由だけ設定側の装置名が無視されていた
            deviceName: input.deviceName ?? src.deviceName,
            ...(src.ccsid !== undefined ? { ccsid: src.ccsid } : {}),
            user: src.user,
            password: src.password,
            ...(src.tls !== undefined ? { tls: src.tls } : {}),
            // 自動蓄積/印刷はサーバー設定のセッション由来のときだけ（判定は ConfigResolver 内）
            ...withOutput(target?.printerOutput),
            // 表示セッションと同じ理由で永続を通さない（`mcpIdleTimeout`）
            idleTimeoutMs: mcpIdleTimeout(target?.connect.idleTimeoutMs),
            origin: originOf(input)
          });
          const code = entry.session.startupCode;
          return {
            content: [{ type: "text" as const, text: `printer session ${entry.id} (${code})` }],
            structuredContent: { sessionId: entry.id, startupCode: code }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "wait_spool",
    {
      description:
        "プリンターセッションで次のスプール（ジョブ完了 1 件）を待って取得する。既に届いていれば即返す。" +
        "timeoutMs 内に来なければ received=false。pages はページごとの等幅テキスト、text は全体。",
      inputSchema: { sessionId: z.string(), timeoutMs: z.number().int().optional() },
      outputSchema: {
        received: z.boolean(),
        spoolId: z.string().optional(),
        pages: z.array(z.string()).optional(),
        text: z.string().optional()
      }
    },
    async ({ sessionId, timeoutMs }) =>
      withAudit({ op: "wait_spool", sessionId }, async () => {
        try {
          sessions.getPrinter(sessionId, user); // 存在確認（無ければ SESSION_NOT_FOUND）
          const report = await sessions.waitSpool(sessionId, timeoutMs ?? 30_000, user);
          if (!report) {
            return {
              content: [{ type: "text" as const, text: "no spool received (timeout)" }],
              structuredContent: { received: false }
            };
          }
          const pages = report.pages.map((p) => p.lines.join("\n"));
          const text = pages.join("\n\n");
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: { received: true, spoolId: report.id, pages, text }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "list_spools",
    {
      description: "プリンターセッションでこれまでに受信したスプールの一覧（ページ数付き）。",
      inputSchema: { sessionId: z.string() },
      outputSchema: {
        spools: z.array(z.object({ spoolId: z.string(), pages: z.number() }))
      }
    },
    async ({ sessionId }) =>
      withAudit({ op: "list_spools", sessionId }, async () => {
        try {
          const entry = sessions.getPrinter(sessionId, user);
          const spools = entry.reports.map((r) => ({ spoolId: r.id, pages: r.pages.length }));
          return {
            content: [{ type: "text" as const, text: `${spools.length} spool(s)` }],
            structuredContent: { spools }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "get_spool",
    {
      description: "受信済みスプールを spoolId 指定で再取得する（等幅テキスト）。",
      inputSchema: { sessionId: z.string(), spoolId: z.string() },
      outputSchema: { pages: z.array(z.string()), text: z.string() }
    },
    async ({ sessionId, spoolId }) =>
      withAudit({ op: "get_spool", sessionId }, async () => {
        try {
          const entry = sessions.getPrinter(sessionId, user);
          const report = entry.reports.find((r) => r.id === spoolId);
          if (!report) throw new As400Error("SESSION_NOT_FOUND", `spool ${spoolId} not found`);
          const pages = report.pages.map((p) => p.lines.join("\n"));
          const text = pages.join("\n\n");
          return { content: [{ type: "text" as const, text }], structuredContent: { pages, text } };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "get_spool_pdf",
    {
      description: "受信済みスプールを PDF に変換して取得する（base64）。SBCS/DBCS 対応・等幅・改ページ保持。",
      inputSchema: { sessionId: z.string(), spoolId: z.string() },
      outputSchema: { base64: z.string(), bytes: z.number() }
    },
    async ({ sessionId, spoolId }) =>
      withAudit({ op: "get_spool_pdf", sessionId }, async () => {
        try {
          const entry = sessions.getPrinter(sessionId, user);
          const report = entry.reports.find((r) => r.id === spoolId);
          if (!report) throw new As400Error("SESSION_NOT_FOUND", `spool ${spoolId} not found`);
          const pdf = await renderSpoolPdf(report.pages);
          const base64 = pdf.toString("base64");
          return {
            content: [{ type: "text" as const, text: `PDF ${pdf.length} bytes (base64)` }],
            structuredContent: { base64, bytes: pdf.length }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  /**
   * PDF は紙に落とすためのもので、開くのに閲覧環境が要り、差分も取れない。
   * こちらは `get_screen_html` と同じくブラウザだけで開けて、検索もコピーも差分も効く。
   */
  server.registerTool(
    "get_spool_html",
    {
      description:
        "受信済みスプールを、等幅・改ページを保った自己完結 HTML で取得する（get_spool_pdf の HTML 版）。" +
        "外部 CSS/JS/フォントを参照せず、HTML 単体で開ける。ページを行き来でき、印刷すれば改ページも保たれる。" +
        "決定的な変換なので、同じスプールからは常に同じ HTML が出る。",
      inputSchema: {
        sessionId: z.string(),
        spoolId: z.string(),
        title: z.string().optional(),
        note: z.string().optional()
      },
      outputSchema: { html: z.string(), bytes: z.number(), pages: z.number() }
    },
    async ({ sessionId, spoolId, title, note }) =>
      withAudit({ op: "get_spool_html", sessionId }, async () => {
        try {
          const entry = sessions.getPrinter(sessionId, user);
          const report = entry.reports.find((r) => r.id === spoolId);
          if (!report) throw new As400Error("SESSION_NOT_FOUND", `spool ${spoolId} not found`);
          const html = renderSpoolHtml(report.pages, {
            capturedAt: new Date().toISOString(),
            sessionId,
            host: entry.host,
            spoolId,
            ...(title !== undefined ? { title } : {}),
            ...(note !== undefined ? { note } : {})
          });
          return {
            content: [{ type: "text" as const, text: `HTML ${html.length} bytes (${report.pages.length} pages)` }],
            structuredContent: { html, bytes: html.length, pages: report.pages.length }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "get_screen",
    {
      description: "現在の画面を取得（テキスト＋構造化）。include/rows で絞り込み可。",
      inputSchema: { sessionId: z.string(), include: includeSchema, rows: rowsSchema },
      outputSchema: screenOutShape
    },
    async ({ sessionId, include, rows }) =>
      withAudit({ op: "get_screen", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId, user);
          return screenResult(entry.session.snapshot(), fmtOpts({ include, rows }));
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  /**
   * 画面をそのまま人に見せられる形（HTML）で出す。テキストや属性 run は LLM 向けで、
   * **人がエビデンスとして読むには足りない**（色も強調も無い／座標の羅列は頭で再構成できない）。
   */
  server.registerTool(
    "get_screen_html",
    {
      description:
        "現在の画面を、5250 エミュレータの見た目を忠実に再現した自己完結 HTML で取得する（自動操作のエビデンス用）。" +
        "外部 CSS/JS/フォントを参照せず、HTML 単体で開ける。ダーク/ライトを画面上のボタンで切り替えられる。" +
        "決定的な変換なので、同じ画面からは常に同じ HTML が出る。",
      inputSchema: { sessionId: z.string(), title: z.string().optional(), note: z.string().optional() },
      outputSchema: { html: z.string(), bytes: z.number() }
    },
    async ({ sessionId, title, note }) =>
      withAudit({ op: "get_screen_html", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId, user);
          const html = renderScreenHtml(entry.session.snapshot(), {
            capturedAt: new Date().toISOString(),
            sessionId,
            host: entry.host,
            ...(entry.job ? { job: jobLabel(entry.job) } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(note !== undefined ? { note } : {})
          });
          return {
            content: [{ type: "text" as const, text: `HTML ${html.length} bytes` }],
            structuredContent: { html, bytes: html.length }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  /**
   * 記録は**頼まれたときだけ**動かす。全セッションを常時記録すると、使わない画面のために
   * メモリを食い続けるうえ、画面に写る入力値が黙って溜まる（`screen-recorder.ts`）。
   */
  server.registerTool(
    "start_screen_recording",
    {
      description:
        "このセッションの画面遷移の記録を開始する（get_screen_history_html で HTML にまとめる）。" +
        "開始時点の画面が 1 コマ目になる。記録するのは画面と送信キーだけで、入力値は残さない。",
      inputSchema: { sessionId: z.string(), limit: z.number().int().min(1).max(500).optional() },
      outputSchema: { recording: z.boolean(), frames: z.number() }
    },
    async ({ sessionId, limit }) =>
      withAudit({ op: "start_screen_recording", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId, user);
          entry.recorder ??= new ScreenRecorder(entry.session, limit ?? 100);
          entry.recorder.start();
          return {
            content: [{ type: "text" as const, text: "recording" }],
            structuredContent: { recording: true, frames: entry.recorder.count }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "stop_screen_recording",
    {
      description: "画面遷移の記録を停止する。記録済みのコマは残るので、停止後に取り出せる。",
      inputSchema: { sessionId: z.string() },
      outputSchema: { recording: z.boolean(), frames: z.number() }
    },
    async ({ sessionId }) =>
      withAudit({ op: "stop_screen_recording", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId, user);
          entry.recorder?.stop();
          return {
            content: [{ type: "text" as const, text: "stopped" }],
            structuredContent: { recording: false, frames: entry.recorder?.count ?? 0 }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "get_screen_history_html",
    {
      description:
        "記録した画面遷移を、前後にたどれるナビゲーション付きの自己完結 HTML にまとめて取得する。" +
        "各コマの描画は get_screen_html と同一（描画経路を二重に持たない）。clear で取り出し後に記録を捨てる。",
      inputSchema: {
        sessionId: z.string(),
        title: z.string().optional(),
        note: z.string().optional(),
        clear: z.boolean().optional()
      },
      outputSchema: { html: z.string(), bytes: z.number(), frames: z.number() }
    },
    async ({ sessionId, title, note, clear }) =>
      withAudit({ op: "get_screen_history_html", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId, user);
          const frames = entry.recorder?.snapshotFrames() ?? [];
          const html = renderScreenHistoryHtml(frames, {
            capturedAt: new Date().toISOString(),
            sessionId,
            host: entry.host,
            ...(entry.job ? { job: jobLabel(entry.job) } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(note !== undefined ? { note } : {})
          });
          if (clear) entry.recorder?.clear();
          return {
            content: [{ type: "text" as const, text: `HTML ${html.length} bytes (${frames.length} frames)` }],
            structuredContent: { html, bytes: html.length, frames: frames.length }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "wait_screen",
    {
      description:
        "ホスト発の画面更新を待つ（バッチ完了メッセージ等のポーリング撲滅）。until 指定で特定テキスト出現を待つ。",
      inputSchema: {
        sessionId: z.string(),
        timeoutMs: z.number().int().optional(),
        until: z.object({ text: z.string(), row: z.number().int().optional() }).optional(),
        include: includeSchema,
        rows: rowsSchema
      },
      outputSchema: screenOutShape
    },
    async ({ sessionId, timeoutMs, until, include, rows }) =>
      withAudit({ op: "wait_screen", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId, user);
          const opts: { timeoutMs?: number; until?: { text: string; row?: number } } = {};
          if (timeoutMs !== undefined) opts.timeoutMs = timeoutMs;
          if (until) {
            opts.until = until.row !== undefined ? { text: until.text, row: until.row } : { text: until.text };
          }
          const r = await entry.session.waitForScreen(opts);
          return screenResult(r.screen, fmtOpts({ include, rows }), r.timedOut);
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "set_fields",
    {
      description: "フィールドにローカル入力する（ホスト送信なし）。readOnly セッションは拒否。",
      inputSchema: { sessionId: z.string(), fields: z.array(fieldInputSchema) },
      outputSchema: screenOutShape
    },
    async ({ sessionId, fields }) =>
      withAudit(
        { op: "set_fields", sessionId, fields: fieldCoords(fields) },
        async () => {
          try {
            const entry = sessions.assertWritable(sessionId, user);
            for (const f of fields) entry.session.setField(fieldTarget(f.field), f.value);
            return screenResult(entry.session.snapshot(), {});
          } catch (err) {
            return errorResult(err);
          }
        }
      )
  );

  server.registerTool(
    "send_key",
    {
      description:
        "フィールドを反映しカーソルを設定して AID キーを送信、更新後画面を返す。readOnly は PageUp/Down のみ。",
      inputSchema: {
        sessionId: z.string(),
        key: z.enum(AID_KEYS),
        cursor: cursorSchema.optional(),
        fields: z.array(fieldInputSchema).optional(),
        sysReqText: z
          .string()
          .optional()
          .describe("システム要求行の文字列（SysReq 専用。省略でシステム要求メニュー）"),
        include: includeSchema,
        rows: rowsSchema
      },
      outputSchema: screenOutShape
    },
    async ({ sessionId, key, cursor, fields, sysReqText, include, rows }) =>
      withAudit({ op: "send_key", sessionId, key, ...(fields ? { fields: fieldCoords(fields) } : {}) }, async () => {
        try {
          const entry = sessions.assertKeyAllowed(sessionId, key, user);
          if (fields) {
            sessions.assertWritable(sessionId, user);
            for (const f of fields) entry.session.setField(fieldTarget(f.field), f.value);
          }
          // 記録中なら、この画面遷移を起こした操作として次のコマに添える
          entry.recorder?.noteKey(key);
          const r = await entry.session.sendAid(key, {
            ...(cursor ? { cursor } : {}),
            ...(sysReqText !== undefined ? { sysReqText } : {})
          });
          return screenResult(r.screen, fmtOpts({ include, rows }), r.timedOut);
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "select_gui_choice",
    {
      description:
        "拡張 5250 GUI 選択フィールドの選択状態を更新（ローカルのみ・ホスト送信なし）。" +
        "単一選択（radio/pushbutton/menu）は排他、複数選択（checkbox）は独立トグル。readOnly は拒否。",
      inputSchema: {
        sessionId: z.string(),
        fieldId: z.number().int(),
        choiceIndex: z.number().int(),
        selected: z.boolean().optional()
      },
      outputSchema: screenOutShape
    },
    async ({ sessionId, fieldId, choiceIndex, selected }) =>
      withAudit({ op: "select_gui_choice", sessionId }, async () => {
        try {
          const entry = sessions.assertWritable(sessionId, user);
          const ok = entry.session.selectGuiChoice(fieldId, choiceIndex, selected ?? true);
          if (!ok) {
            throw new As400Error("FIELD_TYPE", `選択できません（fieldId=${fieldId} choice=${choiceIndex}）`);
          }
          return screenResult(entry.session.snapshot(), {});
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "submit_gui_selection",
    {
      description:
        "拡張 5250 GUI 選択フィールドを確定送信する。選択済み選択肢が AID を持てばその AID を、" +
        "無ければ key（既定 Enter）を Read 応答として送り、更新後画面を返す。readOnly は拒否。",
      inputSchema: {
        sessionId: z.string(),
        fieldId: z.number().int(),
        key: z.enum(AID_KEYS).optional(),
        cursor: cursorSchema.optional(),
        include: includeSchema,
        rows: rowsSchema
      },
      outputSchema: screenOutShape
    },
    async ({ sessionId, fieldId, key, cursor, include, rows }) =>
      withAudit({ op: "submit_gui_selection", sessionId, ...(key ? { key } : {}) }, async () => {
        try {
          const entry = sessions.assertWritable(sessionId, user);
          const opts: SendAidOptions & { key?: AidKey } = {};
          if (key) opts.key = key;
          if (cursor) opts.cursor = cursor;
          const r = await entry.session.submitGuiSelection(fieldId, opts);
          return screenResult(r.screen, fmtOpts({ include, rows }), r.timedOut);
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "run_steps",
    {
      description:
        "複数ステップ（fields+key+expect）を順次実行。expect 不一致またはエラーで中断し、実行済み数と画面を返す。",
      inputSchema: {
        sessionId: z.string(),
        steps: z
          .array(
            z.object({
              fields: z.array(fieldInputSchema).optional(),
              key: z.enum(AID_KEYS),
              cursor: cursorSchema.optional(),
              expect: z.object({ text: z.string(), row: z.number().int().optional() }).optional()
            })
          )
          .max(20),
        include: includeSchema,
        rows: rowsSchema
      },
      outputSchema: {
        executed: z.number(),
        stopped: z.boolean(),
        reason: z.string().optional(),
        ...screenOutShape
      }
    },
    async ({ sessionId, steps, include, rows }) =>
      withAudit({ op: "run_steps", sessionId }, async () => {
        try {
          const entry = sessions.assertWritable(sessionId, user);
          let executed = 0;
          let stopped = false;
          let reason: string | undefined;
          let last: SendAidResult | undefined;
          for (const step of steps) {
            sessions.assertKeyAllowed(sessionId, step.key, user);
            if (step.fields) for (const f of step.fields) entry.session.setField(fieldTarget(f.field), f.value);
            entry.recorder?.noteKey(step.key);
            last = await entry.session.sendAid(step.key, step.cursor ? { cursor: step.cursor } : {});
            executed++;
            if (step.expect && !screenHas(last.screen, step.expect)) {
              stopped = true;
              reason = `expect not met after step ${executed}: "${step.expect.text}"`;
              break;
            }
          }
          const snap = last ? last.screen : entry.session.snapshot();
          const base = screenResult(snap, fmtOpts({ include, rows }), last?.timedOut);
          Object.assign(base.structuredContent, { executed, stopped, ...(reason ? { reason } : {}) });
          return base;
        } catch (err) {
          return errorResult(err);
        }
      })
  );

  server.registerTool(
    "get_job_info",
    {
      description:
        "セッションのジョブ識別子（ジョブ名＝装置名／システム名／分かればユーザー・番号）を返す。" +
        "**画面には触れない**——接続時の起動応答とジョブ一覧から既に得ている情報を返すだけ。",
      inputSchema: { sessionId: z.string() },
      outputSchema: {
        job: z.object({
          name: z.string(),
          system: z.string().optional(),
          user: z.string().optional(),
          number: z.string().optional()
        })
      }
    },
    async ({ sessionId }) =>
      withAudit({ op: "get_job_info", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId, user);
          // 背後の解決が終わっていれば待つ（既に終わっていれば即座に返る）
          const job = (await entry.jobResolved) ?? entry.job;
          if (!job) {
            return errorResult(
              new As400Error(
                "NOT_FOUND",
                "このセッションのジョブ識別子は分かりません（起動応答が無いホストの可能性）"
              )
            );
          }
          const text = job.number
            ? `${job.number}/${job.user}/${job.name}`
            : `${job.name}${job.system ? ` (${job.system})` : ""}`;
          return {
            content: [{ type: "text" as const, text }],
            structuredContent: { job }
          };
        } catch (err) {
          return errorResult(err);
        }
      })
  );
}

function buildDirectOpts(input: {
  host?: string | undefined;
  port?: number | undefined;
  ccsid?: number | undefined;
  screenSize?: "24x80" | "27x132" | undefined;
  deviceName?: string | undefined;
  enhanced?: boolean | undefined;
  tls?: boolean | undefined;
}): {
  host: string;
  port?: number;
  ccsid?: number;
  screenSize?: "24x80" | "27x132";
  deviceName?: string;
  enhanced?: boolean;
  tls?: boolean;
  origin: string;
} {
  if (!input.host) throw new As400Error("CONFIG_ERROR", "host or profile required");
  const o: {
    host: string;
    port?: number;
    ccsid?: number;
    screenSize?: "24x80" | "27x132";
    deviceName?: string;
    enhanced?: boolean;
    tls?: boolean;
    origin: string;
  } = {
    host: input.host,
    origin: "direct"
  };
  if (input.port !== undefined) o.port = input.port;
  if (input.ccsid !== undefined) o.ccsid = input.ccsid;
  if (input.screenSize !== undefined) o.screenSize = input.screenSize;
  if (input.deviceName !== undefined) o.deviceName = input.deviceName;
  if (input.enhanced !== undefined) o.enhanced = input.enhanced;
  if (input.tls !== undefined) o.tls = input.tls;
  return o;
}

function fieldCoords(fields: FieldInput[]): { row: number; col: number }[] {
  return fields
    .map((f) => f.field)
    .filter((f): f is { row: number; col: number } => typeof f !== "number");
}

function screenHas(snap: ScreenSnapshot, expect: { text: string; row?: number | undefined }): boolean {
  const rows = expect.row !== undefined ? [snap.cells[expect.row - 1] ?? []] : snap.cells;
  return rows.map((r) => r.map((c) => c.char).join("")).join("\n").includes(expect.text);
}

/**
 * MCP 経由セッションのアイドル上限。**設定の「永続」は通さない**（research F2）。
 *
 * MCP は `StreamableHTTPTransport` のツール呼び出しごとの HTTP で、クライアントが落ちても
 * 通知が来ない。ブラウザ経路は WS の切断とハートビートが孤児を回収するが、こちらには
 * 回収する者が居ない——永続を許すと `maxSessions` を食い潰し、装置記述も掴んだままになる。
 *
 * **設定を曲げる唯一の箇所なので黙ってやらない**。warn に出す。
 */
function mcpIdleTimeout(v: number | "never" | undefined): number {
  const ms = orphanSafeIdleTimeoutMs(v);
  if (v === "never") {
    mcpLog.warn(
      { idleTimeoutMs: ms },
      "MCP セッションには永続を適用しない（切断が通知されないため）。有限値に落とした"
    );
  }
  return ms;
}

/** プリンター出力設定を openPrinter のオプション断片へ（未設定なら空＝自動出力なし） */
function withOutput(output: PrinterOutputConfig | undefined): { output?: PrinterOutputConfig } {
  return output ? { output } : {};
}

/** ジョブ識別子の表示形（`番号/ユーザー/ジョブ名`。引けていなければ装置名だけ） */
function jobLabel(job: { name: string; system?: string; user?: string; number?: string }): string {
  return job.number ? `${job.number}/${job.user}/${job.name}` : job.name;
}
