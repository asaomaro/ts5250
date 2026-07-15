import { childLog } from "@as400web/core";

/**
 * 監査ログ（spec D14）。全 MCP/WS 操作を stderr に構造化記録する。
 * **フィールド値は記録しない**（座標・種別・結果のみ）。認証情報が証跡に漏れないようにする。
 */
export interface AuditEvent {
  op: string;
  sessionId?: string;
  /** 操作対象フィールドの座標（値は含めない） */
  fields?: { row: number; col: number }[];
  key?: string;
  result: "ok" | "error";
  code?: string;
  durationMs?: number;
}

const log = childLog({ component: "audit" });

type AuditSink = (event: AuditEvent) => void;
let sink: AuditSink = (event) => log.info(event, `audit ${event.op} ${event.result}`);

/** 監査 sink を差し替える（テスト用。既定は pino/stderr） */
export function setAuditSink(fn: AuditSink): void {
  sink = fn;
}

export function audit(event: AuditEvent): void {
  sink(event);
}

/**
 * 操作を計測してラップする（now 注入でテスト可能）。
 * fn が例外を投げた場合に加え、**MCP エラー応答（`isError: true`）を返した場合も result:"error"** を記録する
 * （ツールは例外を投げず isError 応答を返すため。監査証跡の正確性 = spec D14）。
 */
export async function withAudit<T>(
  base: Omit<AuditEvent, "result" | "durationMs" | "code">,
  fn: () => Promise<T>,
  now: () => number = () => Date.now()
): Promise<T> {
  const start = now();
  try {
    const value = await fn();
    const errCode = mcpErrorCode(value);
    audit({
      ...base,
      result: errCode !== undefined ? "error" : "ok",
      ...(errCode !== undefined ? { code: errCode } : {}),
      durationMs: now() - start
    });
    return value;
  } catch (err) {
    const code = (err as { code?: string }).code;
    audit({ ...base, result: "error", ...(code ? { code } : {}), durationMs: now() - start });
    throw err;
  }
}

/** MCP ツール応答が isError なら error code（structuredContent.error.code）を返す */
function mcpErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { isError?: unknown; structuredContent?: { error?: { code?: unknown } } };
  if (v.isError !== true) return undefined;
  const code = v.structuredContent?.error?.code;
  return typeof code === "string" ? code : "ERROR";
}
