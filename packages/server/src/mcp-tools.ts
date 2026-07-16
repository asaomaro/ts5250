import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Tn5250Error,
  type ScreenSnapshot,
  type SendAidResult,
  type SendAidOptions,
  type AidKey
} from "@as400web/core";
import { SessionManager } from "./session-manager.js";
import { ProfileStore } from "./profiles.js";
import { screenToText, type FormatOptions } from "./format.js";
import { fieldSignon } from "./signon.js";
import { withAudit } from "./audit.js";

export interface ToolDeps {
  sessions: SessionManager;
  profiles: ProfileStore;
  version: string;
}

const AID_KEYS = [
  "Enter", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
  "PageUp", "PageDown", "Clear", "Help", "Print", "SysReq", "Attn"
] as const;

// ---- 共通スキーマ ----
const includeSchema = z.array(z.enum(["grid", "fields"])).optional();
const rowsSchema = z.object({ from: z.number().int(), to: z.number().int() }).optional();
const cursorSchema = z.object({ row: z.number().int(), col: z.number().int() });
const fieldInputSchema = z.object({
  field: z.union([z.number().int(), cursorSchema]),
  value: z.string()
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
      title: z.string().optional(),
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
  gui: guiSchema.optional()
};

type FieldInput = z.infer<typeof fieldInputSchema>;

function fieldTarget(f: FieldInput["field"]): { index: number } | { row: number; col: number } {
  return typeof f === "number" ? { index: f } : { row: f.row, col: f.col };
}

/** 画面応答を組み立てる。画面テキストは content[].text と structuredContent.text の両方に載せる */
function screenResult(snap: ScreenSnapshot, fmt: FormatOptions, timedOut?: boolean) {
  const text = screenToText(snap, fmt);
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
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured
  };
}

function fmtOpts(input: {
  include?: ("grid" | "fields")[] | undefined;
  rows?: { from: number; to: number } | undefined;
}): FormatOptions {
  const o: FormatOptions = {};
  if (input.include) o.include = input.include;
  if (input.rows) o.rows = input.rows;
  return o;
}

/** エラーを MCP の isError レスポンスに変換する */
function errorResult(err: unknown) {
  const code = err instanceof Tn5250Error ? err.code : "INTERNAL_ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } }
  };
}

/**
 * 10 個の MCP ツールを McpServer に登録する（spec「MCP ツール」）。
 * 全ツール zod 入力スキーマ＋outputSchema、画面を返すものは text+structuredContent。
 * 認証情報はツール引数に取らない（D13）。サインオンは profile 経由（自動）か signon ツール（画面フィールド）。
 */
export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { sessions, profiles } = deps;

  server.registerTool(
    "open_session",
    {
      description:
        "5250 セッションを開く。profile 指定で設定プロファイルから接続（自動サインオンあり）、" +
        "または host 等を直接指定。readOnly で閲覧専用。認証情報は引数に取らない（profile 経由）。",
      inputSchema: {
        profile: z.string().optional(),
        host: z.string().optional(),
        port: z.number().int().optional(),
        ccsid: z.number().int().optional(),
        deviceName: z.string().optional(),
        enhanced: z.boolean().optional(),
        readOnly: z.boolean().optional()
      },
      outputSchema: screenOutShape
    },
    async (input) =>
      withAudit({ op: "open_session" }, async () => {
        try {
          const opts = input.profile
            ? { ...profiles.resolveConnectOptions(input.profile), origin: input.profile }
            : buildDirectOpts(input);
          const entry = await sessions.open({ ...opts, readOnly: input.readOnly ?? false });
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
        "接続済みセッションの現在画面に、profile の資格情報を画面フィールド入力してサインオン（フォールバック）。" +
        "PUB400 等は auto-signon 済みの open_session を推奨。",
      inputSchema: { sessionId: z.string(), profile: z.string() },
      outputSchema: screenOutShape
    },
    async ({ sessionId, profile }) =>
      withAudit({ op: "signon", sessionId }, async () => {
        try {
          const entry = sessions.assertWritable(sessionId);
          const opts = profiles.resolveConnectOptions(profile);
          if (!opts.user || !opts.password) {
            throw new Tn5250Error("CONNECT_FAILED", `profile ${profile} has no signon credentials`);
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
          await sessions.close(sessionId);
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
        const list = sessions.list().map((e) => ({
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
    "get_screen",
    {
      description: "現在の画面を取得（テキスト＋構造化）。include/rows で絞り込み可。",
      inputSchema: { sessionId: z.string(), include: includeSchema, rows: rowsSchema },
      outputSchema: screenOutShape
    },
    async ({ sessionId, include, rows }) =>
      withAudit({ op: "get_screen", sessionId }, async () => {
        try {
          const entry = sessions.get(sessionId);
          return screenResult(entry.session.snapshot(), fmtOpts({ include, rows }));
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
          const entry = sessions.get(sessionId);
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
            const entry = sessions.assertWritable(sessionId);
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
        include: includeSchema,
        rows: rowsSchema
      },
      outputSchema: screenOutShape
    },
    async ({ sessionId, key, cursor, fields, include, rows }) =>
      withAudit({ op: "send_key", sessionId, key, ...(fields ? { fields: fieldCoords(fields) } : {}) }, async () => {
        try {
          const entry = sessions.assertKeyAllowed(sessionId, key);
          if (fields) {
            sessions.assertWritable(sessionId);
            for (const f of fields) entry.session.setField(fieldTarget(f.field), f.value);
          }
          const r = await entry.session.sendAid(key, cursor ? { cursor } : {});
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
          const entry = sessions.assertWritable(sessionId);
          const ok = entry.session.selectGuiChoice(fieldId, choiceIndex, selected ?? true);
          if (!ok) {
            throw new Tn5250Error("FIELD_TYPE", `選択できません（fieldId=${fieldId} choice=${choiceIndex}）`);
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
          const entry = sessions.assertWritable(sessionId);
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
          const entry = sessions.assertWritable(sessionId);
          let executed = 0;
          let stopped = false;
          let reason: string | undefined;
          let last: SendAidResult | undefined;
          for (const step of steps) {
            sessions.assertKeyAllowed(sessionId, step.key);
            if (step.fields) for (const f of step.fields) entry.session.setField(fieldTarget(f.field), f.value);
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
        "対話ジョブの識別子（番号/ユーザー/ジョブ名）を取得（コマンド行に DSPJOB を実行→F3 復帰）。取得済みはキャッシュ。",
      inputSchema: { sessionId: z.string(), refresh: z.boolean().optional() },
      outputSchema: {
        job: z.object({ number: z.string(), user: z.string(), name: z.string() })
      }
    },
    async ({ sessionId, refresh }) =>
      withAudit({ op: "get_job_info", sessionId }, async () => {
        try {
          const entry = sessions.assertWritable(sessionId);
          const job = await entry.session.fetchJobInfo(refresh ?? false);
          return {
            content: [{ type: "text" as const, text: `${job.number}/${job.user}/${job.name}` }],
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
  deviceName?: string | undefined;
  enhanced?: boolean | undefined;
}): {
  host: string;
  port?: number;
  ccsid?: number;
  deviceName?: string;
  enhanced?: boolean;
  origin: string;
} {
  if (!input.host) throw new Tn5250Error("CONNECT_FAILED", "host or profile required");
  const o: {
    host: string;
    port?: number;
    ccsid?: number;
    deviceName?: string;
    enhanced?: boolean;
    origin: string;
  } = {
    host: input.host,
    origin: "direct"
  };
  if (input.port !== undefined) o.port = input.port;
  if (input.ccsid !== undefined) o.ccsid = input.ccsid;
  if (input.deviceName !== undefined) o.deviceName = input.deviceName;
  if (input.enhanced !== undefined) o.enhanced = input.enhanced;
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
