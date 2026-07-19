/**
 * ホストサーバー経由の HTTP API に共通する部品。
 *
 * `host-lists.ts` に閉じていたものを、SQL API（`host-sql.ts`）が 3 箇所目の利用者になった時点で
 * 切り出した。**同じ形を 3 度書かない**——とくに `sourceSchema` と `statusOf` は、
 * ずれると「接続先の指定方法が API ごとに違う」「同じ失敗が別のステータスで返る」ことになる。
 */
import { z } from "zod";
import { As400Error, type ConnectOptions } from "@as400web/core";
import { childLog } from "./log.js";
import type { AuthUser } from "./auth.js";
import type { ConfigResolver } from "./config-resolver.js";

const apiLog = childLog({ component: "host-api" });

/**
 * 取得元の指定。**システムだけで足りる**——ホストサーバーは装置名も画面サイズも使わないため。
 * セッション設定を指定してもよい（親システムに解決される）が、必須ではない。
 */
export const sourceSchema = z
  .object({
    system: z.string().optional(),
    session: z.string().optional()
  })
  .strict()
  .refine((v) => Boolean(v.system ?? v.session), {
    message: "system または session を指定してください"
  });

export type SourceInput = z.infer<typeof sourceSchema>;

/**
 * エラーを HTTP ステータスへ写す。
 *
 * **502 は「上流（IBM i）との通信に失敗した」意味に限る。**
 * 設定の誤りや認可の失敗まで 502 にすると、呼び出し側が
 * 「ホストが落ちている」のか「指定が間違っている」のかを区別できない。
 */
export function statusOf(e: As400Error): 400 | 403 | 404 | 502 {
  switch (e.code) {
    case "FORBIDDEN":
      return 403;
    case "SESSION_NOT_FOUND":
      return 404;
    case "CONFIG_ERROR":
    case "CONNECT_FAILED":
    case "SQL_ERROR":
      return 400;
    default:
      return 502;
  }
}

/**
 * 未指定（undefined）の項目を落とす。
 * `exactOptionalPropertyTypes` のため、`{ user: undefined }` は
 * 「指定していない」ではなく「undefined を指定した」になってしまう。
 */
export function compact<T extends object>(value: T | undefined): {
  [K in keyof T]-?: Exclude<T[K], undefined>;
} {
  if (!value) return {} as never;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

/** 接続設定から資格情報を解く。**ブラウザへは渡さない**（解決結果はサーバー内に留める） */
export function resolveSource(
  resolver: ConfigResolver,
  source: SourceInput,
  user: AuthUser | undefined
): ConnectOptions {
  return resolver.resolve({ system: source.system, session: source.session }, user, (m) =>
    apiLog.warn(m)
  ).connect;
}
