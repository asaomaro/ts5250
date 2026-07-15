import pino, { type Logger } from "pino";

/**
 * 共通ロガー（spec D9: ログは stderr のみ。stdout は stdio MCP 専用）。
 * 全パッケージこのラッパ経由でログを出す。console.* は lint（no-console）で禁止。
 */
export const log: Logger = pino(
  {
    level: process.env["LOG_LEVEL"] ?? "info",
    base: null
  },
  pino.destination(2)
);

export function childLog(bindings: Record<string, unknown>): Logger {
  return log.child(bindings);
}
