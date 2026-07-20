/**
 * サーバーのロガー（spec D9: ログは stderr のみ。stdout は stdio MCP 専用）。
 *
 * **core ではなくここで pino を持つ。** 以前は `@as400web/core` の `childLog` に
 * 相乗りしていたが、core をライブラリとして切り出すにあたり core からロガー実装を外した。
 *
 * サーバー側が core の注入に依存し続けると、`setLogSink` の呼び忘れで
 * **監査証跡（`audit.ts`）が静かに消える**——気づきにくく、消えて最も困る種類のログである。
 * そこで依存の向きを逆にし、**サーバーは常に自前で出す**。core 側（hostserver の debug）は
 * `main.ts` が起動時に注入する。
 */
import pino, { type Logger } from "pino";

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
